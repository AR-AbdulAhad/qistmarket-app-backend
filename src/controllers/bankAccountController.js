const prisma = require('../../lib/prisma');
const crypto = require('crypto');
const { logAction } = require('../utils/auditLogger');
const { generateDqr } = require('../utils/smartPayGateway');
const { generateConsumerNumber, generateSmartPayConsumerNumber } = require('../utils/consumerNumberUtils');

const now = () => new Date();

const getBankAccounts = async (req, res) => {
    try {
        const { outletId } = req.query;
        const where = {};
        if (outletId && outletId !== 'all') where.outlet_id = parseInt(outletId);

        const accounts = await prisma.bankAccount.findMany({
            where,
            include: { outlet: { select: { id: true, name: true } } },
            orderBy: { created_at: 'desc' },
        });

        res.json({ success: true, data: accounts });
    } catch (error) {
        console.error('getBankAccounts error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getBankBalanceSummary = async (req, res) => {
    try {
        const accounts = await prisma.bankAccount.findMany({
            where: { is_active: true },
            include: { outlet: { select: { id: true, name: true } } },
        });

        const totalBalance = accounts.reduce((acc, a) => acc + a.current_balance, 0);

        res.json({
            success: true,
            data: {
                totalBalance,
                accountCount: accounts.length,
                bankWise: accounts.map((a) => ({
                    id: a.id,
                    bank_name: a.bank_name,
                    account_title: a.account_title,
                    account_number: a.account_number,
                    outlet_name: a.outlet?.name || 'Head Office',
                    current_balance: a.current_balance,
                })),
            },
        });
    } catch (error) {
        console.error('getBankBalanceSummary error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const createBankAccount = async (req, res) => {
    try {
        const { bank_name, account_title, account_number, iban, branch_code, outlet_id, opening_balance, notes } = req.body;

        if (!bank_name || !account_title || !account_number) {
            return res.status(400).json({ success: false, message: 'Bank name, account title, and account number are required.' });
        }

        const opening = parseFloat(opening_balance) || 0;

        const account = await prisma.bankAccount.create({
            data: {
                bank_name,
                account_title,
                account_number,
                iban: iban || null,
                branch_code: branch_code || null,
                outlet_id: outlet_id ? parseInt(outlet_id) : null,
                opening_balance: opening,
                current_balance: opening,
                notes: notes || null,
                created_by_id: req.user.id,
            },
        });

        await logAction(req, 'BANK_ACCOUNT_CREATED', `Bank account ${account.bank_name} (${account.account_number}) created with opening balance PKR ${opening}.`, account.id, 'BankAccount');

        res.status(201).json({ success: true, data: account });
    } catch (error) {
        if (error.code === 'P2002') {
            return res.status(409).json({ success: false, message: 'An account with this account number already exists.' });
        }
        console.error('createBankAccount error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const updateBankAccount = async (req, res) => {
    try {
        const { id } = req.params;
        const { bank_name, account_title, iban, branch_code, outlet_id, notes, is_active } = req.body;

        const account = await prisma.bankAccount.update({
            where: { id: parseInt(id) },
            data: {
                ...(bank_name !== undefined && { bank_name }),
                ...(account_title !== undefined && { account_title }),
                ...(iban !== undefined && { iban }),
                ...(branch_code !== undefined && { branch_code }),
                ...(outlet_id !== undefined && { outlet_id: outlet_id ? parseInt(outlet_id) : null }),
                ...(notes !== undefined && { notes }),
                ...(is_active !== undefined && { is_active }),
            },
        });

        res.json({ success: true, data: account });
    } catch (error) {
        console.error('updateBankAccount error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getBankAccountLedger = async (req, res) => {
    try {
        const { id } = req.params;
        const account = await prisma.bankAccount.findUnique({ where: { id: parseInt(id) }, include: { outlet: { select: { name: true } } } });
        if (!account) return res.status(404).json({ success: false, message: 'Bank account not found.' });

        const transactions = await prisma.bankTransaction.findMany({
            where: { bank_account_id: parseInt(id) },
            include: { created_by: { select: { full_name: true } } },
            orderBy: { transaction_date: 'desc' },
        });

        res.json({ success: true, data: { account, transactions } });
    } catch (error) {
        console.error('getBankAccountLedger error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const recordBankTransaction = async (req, res) => {
    try {
        const { bank_account_id, type, amount, description, reference, transaction_date } = req.body;

        if (!bank_account_id || !['credit', 'debit'].includes(type) || !amount || parseFloat(amount) <= 0) {
            return res.status(400).json({ success: false, message: 'bank_account_id, a valid type (credit/debit), and a positive amount are required.' });
        }

        const parsedAmount = parseFloat(amount);

        const result = await prisma.$transaction(async (tx) => {
            const account = await tx.bankAccount.findUnique({ where: { id: parseInt(bank_account_id) } });
            if (!account) throw new Error('Bank account not found.');

            const balanceAfter = type === 'credit' ? account.current_balance + parsedAmount : account.current_balance - parsedAmount;

            const transaction = await tx.bankTransaction.create({
                data: {
                    bank_account_id: parseInt(bank_account_id),
                    type,
                    amount: parsedAmount,
                    balance_after: balanceAfter,
                    description: description || null,
                    reference: reference || null,
                    transaction_date: transaction_date ? new Date(transaction_date) : new Date(),
                    created_by_id: req.user.id,
                },
            });

            await tx.bankAccount.update({ where: { id: account.id }, data: { current_balance: balanceAfter } });

            return { transaction, account: { ...account, current_balance: balanceAfter } };
        });

        await logAction(req, 'BANK_TRANSACTION', `${type === 'credit' ? 'Deposit of' : 'Withdrawal of'} PKR ${parsedAmount} recorded on bank account #${bank_account_id}.`, result.transaction.id, 'BankTransaction');

        res.status(201).json({ success: true, data: result });
    } catch (error) {
        console.error('recordBankTransaction error:', error);
        res.status(500).json({ success: false, message: error.message || 'Internal server error' });
    }
};

/**
 * uploadBankStatement
 * Stores an uploaded statement file (reuses the same multer-local +
 * /uploads static pattern as hrDocumentController.uploadEmployeeDocument)
 * against a bank account for later reconciliation.
 */
const uploadBankStatement = async (req, res) => {
    try {
        const { bank_account_id, period_start, period_end } = req.body;
        if (!bank_account_id) return res.status(400).json({ success: false, message: 'bank_account_id is required.' });
        if (!req.file) return res.status(400).json({ success: false, message: 'Statement file is required.' });

        const statement = await prisma.bankStatement.create({
            data: {
                bank_account_id: parseInt(bank_account_id),
                file_url: `/uploads/${req.file.filename}`,
                period_start: period_start ? new Date(period_start) : null,
                period_end: period_end ? new Date(period_end) : null,
                uploaded_by_id: req.user.id,
            },
        });

        await logAction(req, 'BANK_STATEMENT_UPLOADED', `Statement uploaded for bank account #${bank_account_id}.`, statement.id, 'BankStatement');

        res.status(201).json({ success: true, data: statement });
    } catch (error) {
        console.error('uploadBankStatement error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

const getBankStatements = async (req, res) => {
    try {
        const { bank_account_id } = req.query;
        const where = {};
        if (bank_account_id) where.bank_account_id = parseInt(bank_account_id);

        const statements = await prisma.bankStatement.findMany({
            where,
            include: {
                uploaded_by: { select: { full_name: true } },
                _count: { select: { transactions: true } },
            },
            orderBy: { created_at: 'desc' },
        });

        res.json({ success: true, data: statements });
    } catch (error) {
        console.error('getBankStatements error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * reconcileTransactions
 * Marks one or more transactions as reconciled against an uploaded
 * statement — the accountant manually matches lines, this just persists
 * the match (no automated statement-parsing, which would need a specific
 * bank file format to build against).
 */
const reconcileTransactions = async (req, res) => {
    try {
        const { transaction_ids, statement_id } = req.body;
        if (!Array.isArray(transaction_ids) || transaction_ids.length === 0) {
            return res.status(400).json({ success: false, message: 'transaction_ids array is required.' });
        }

        await prisma.bankTransaction.updateMany({
            where: { id: { in: transaction_ids.map((id) => parseInt(id)) } },
            data: { reconciled: true, statement_id: statement_id ? parseInt(statement_id) : null },
        });

        await logAction(req, 'BANK_RECONCILIATION', `${transaction_ids.length} transaction(s) marked reconciled.`, statement_id ? parseInt(statement_id) : null, 'BankStatement');

        res.json({ success: true, message: `${transaction_ids.length} transaction(s) reconciled.` });
    } catch (error) {
        console.error('reconcileTransactions error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * getReconciliationStatus
 * Per-account reconciled vs unreconciled transaction totals, so the UI
 * can show how much of each account's ledger has been matched to a statement.
 */
const getReconciliationStatus = async (req, res) => {
    try {
        const { bank_account_id } = req.params;
        const transactions = await prisma.bankTransaction.findMany({
            where: { bank_account_id: parseInt(bank_account_id) },
            select: { id: true, amount: true, type: true, reconciled: true, transaction_date: true, description: true },
            orderBy: { transaction_date: 'desc' },
        });

        const reconciled = transactions.filter((t) => t.reconciled);
        const unreconciled = transactions.filter((t) => !t.reconciled);

        res.json({
            success: true,
            data: {
                reconciledCount: reconciled.length,
                unreconciledCount: unreconciled.length,
                unreconciledTotal: unreconciled.reduce((acc, t) => acc + (t.type === 'credit' ? t.amount : -t.amount), 0),
                unreconciled,
            },
        });
    } catch (error) {
        console.error('getReconciliationStatus error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * createInterBankTransfer
 * Atomically records a debit on the source account and a credit on the
 * destination account, linked by a shared transfer_group reference.
 */
const createInterBankTransfer = async (req, res) => {
    try {
        const { from_account_id, to_account_id, amount, description, transaction_date } = req.body;

        if (!from_account_id || !to_account_id || from_account_id === to_account_id) {
            return res.status(400).json({ success: false, message: 'from_account_id and to_account_id are required and must differ.' });
        }
        if (!amount || parseFloat(amount) <= 0) {
            return res.status(400).json({ success: false, message: 'A positive amount is required.' });
        }

        const parsedAmount = parseFloat(amount);
        const transferGroup = `TRF-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        const txnDate = transaction_date ? new Date(transaction_date) : new Date();

        const result = await prisma.$transaction(async (tx) => {
            const fromAccount = await tx.bankAccount.findUnique({ where: { id: parseInt(from_account_id) } });
            const toAccount = await tx.bankAccount.findUnique({ where: { id: parseInt(to_account_id) } });
            if (!fromAccount || !toAccount) throw new Error('One or both bank accounts were not found.');

            const fromBalanceAfter = fromAccount.current_balance - parsedAmount;
            const toBalanceAfter = toAccount.current_balance + parsedAmount;

            const debitTxn = await tx.bankTransaction.create({
                data: {
                    bank_account_id: fromAccount.id, type: 'debit', amount: parsedAmount, balance_after: fromBalanceAfter,
                    description: description || `Transfer to ${toAccount.bank_name} (${toAccount.account_number})`,
                    transfer_group: transferGroup, transaction_date: txnDate, created_by_id: req.user.id,
                },
            });
            const creditTxn = await tx.bankTransaction.create({
                data: {
                    bank_account_id: toAccount.id, type: 'credit', amount: parsedAmount, balance_after: toBalanceAfter,
                    description: description || `Transfer from ${fromAccount.bank_name} (${fromAccount.account_number})`,
                    transfer_group: transferGroup, transaction_date: txnDate, created_by_id: req.user.id,
                },
            });

            await tx.bankAccount.update({ where: { id: fromAccount.id }, data: { current_balance: fromBalanceAfter } });
            await tx.bankAccount.update({ where: { id: toAccount.id }, data: { current_balance: toBalanceAfter } });

            return { debitTxn, creditTxn, transferGroup };
        });

        await logAction(req, 'BANK_INTER_TRANSFER', `PKR ${parsedAmount} transferred between bank account #${from_account_id} and #${to_account_id}.`, null, 'BankTransaction');

        res.status(201).json({ success: true, data: result });
    } catch (error) {
        console.error('createInterBankTransfer error:', error);
        res.status(500).json({ success: false, message: error.message || 'Internal server error' });
    }
};

// ─── Bank Deposit Requests (Outlet / Accounts Office) ───────────────

/**
 * listAccountantsForDeposit
 * Accountants an outlet can route a 1Bill/QR deposit to, each flagged
 * bill_busy/qr_busy if their personal consumer number already has another
 * request pending against it (each accountant only has ONE of each number,
 * reused across requests — see docs in the plan / submitBankDeposit below).
 */
const listAccountantsForDeposit = async (req, res) => {
    try {
        const accountants = await prisma.user.findMany({
            where: { role: { name: 'Accountant' }, status: 'active' },
            select: { id: true, full_name: true, bill_consumer_number: true, smart_pay_consumer_number: true },
            orderBy: { full_name: 'asc' }
        });

        const consumerNumbers = accountants
            .flatMap(a => [a.bill_consumer_number, a.smart_pay_consumer_number])
            .filter(Boolean);

        const busyRows = consumerNumbers.length
            ? await prisma.consumerNumber.findMany({
                where: { consumer_number: { in: consumerNumbers }, bill_status: 'U', due_date: { gt: now() } },
                select: { consumer_number: true }
            })
            : [];
        const busySet = new Set(busyRows.map(r => r.consumer_number));

        const data = accountants.map(a => ({
            id: a.id,
            full_name: a.full_name,
            bill_consumer_number: a.bill_consumer_number,
            smart_pay_consumer_number: a.smart_pay_consumer_number,
            bill_busy: a.bill_consumer_number ? busySet.has(a.bill_consumer_number) : true,
            qr_busy: a.smart_pay_consumer_number ? busySet.has(a.smart_pay_consumer_number) : true
        }));

        res.json({ success: true, data });
    } catch (error) {
        console.error('listAccountantsForDeposit error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * tryReserveConsumerNumber
 * Atomically claims a consumer_number's ConsumerNumber row for a new
 * deposit ONLY if it isn't currently marked busy (bill_status 'U' with a
 * still-future due_date) — a single conditional UPDATE...WHERE, so two
 * concurrent requests can't both win the same accountant's number.
 */
const tryReserveConsumerNumber = async (consumerNumber, amountFloat, expiresAt, placeholderRef) => {
    const result = await prisma.consumerNumber.updateMany({
        where: {
            consumer_number: consumerNumber,
            OR: [
                { bill_status: { not: 'U' } },
                { due_date: { lt: now() } }
            ]
        },
        data: {
            amount_due: amountFloat,
            bill_status: 'U',
            due_date: expiresAt,
            cash_submission_ref: placeholderRef,
            updated_at: now()
        }
    });
    return result.count > 0;
};

/**
 * submitBankDeposit
 * manual_deposit: unchanged — proof-based, reviewed by hand by an Accountant.
 * 1bill / qr_payment: routed to a chosen Accountant's personal consumer
 * number (already created for every user at signup — see authController.js),
 * reusing the same ConsumerNumber row the existing 1LINK TPS / SmartPay
 * webhooks (tpsController.billPayment / smartPayController.notifyPayment)
 * already know how to mark paid. No manual verification needed for these —
 * the webhook flips the BankDepositRequest to "verified" itself.
 */
const submitBankDeposit = async (req, res) => {
    try {
        const { amount, bank_account_id, payment_method, description, accountant_id } = req.body;
        const receipt_id = req.body.receipt_id || null;
        let receipt_photo_url = null;

        if (req.file) {
            receipt_photo_url = `/uploads/${req.file.filename}`;
        }

        if (!amount || !payment_method) {
            return res.status(400).json({ success: false, message: 'Amount and payment_method are required.' });
        }

        const amountFloat = parseFloat(amount);
        const outletId = req.user.outlet_id || null;

        let deposit;

        if (payment_method === '1bill' || payment_method === 'qr_payment') {
            const submittingUser = await prisma.user.findUnique({
                where: { id: req.user.id },
                include: { outlet: true }
            });
            if (!submittingUser) {
                return res.status(404).json({ success: false, message: 'Submitting user not found.' });
            }

            let billConsumerNumber = submittingUser.bill_consumer_number;
            let smartPayConsumerNumber = submittingUser.smart_pay_consumer_number;

            if (!billConsumerNumber || !smartPayConsumerNumber) {
                if (!billConsumerNumber) {
                    billConsumerNumber = await generateConsumerNumber(null, submittingUser.phone || '03000000000');
                }
                if (!smartPayConsumerNumber) {
                    smartPayConsumerNumber = await generateSmartPayConsumerNumber(null, submittingUser.phone || '03000000000');
                }

                await prisma.user.update({
                    where: { id: submittingUser.id },
                    data: {
                        bill_consumer_number: billConsumerNumber,
                        smart_pay_consumer_number: smartPayConsumerNumber
                    }
                });
            }

            const consumerNumber = payment_method === '1bill' ? billConsumerNumber : smartPayConsumerNumber;
            if (!consumerNumber) {
                return res.status(400).json({ success: false, message: 'Failed to obtain consumer number for this method.' });
            }

            let beforeRow = await prisma.consumerNumber.findUnique({ where: { consumer_number: consumerNumber } });
            if (!beforeRow) {
                const dueDate = new Date();
                dueDate.setFullYear(dueDate.getFullYear() + 10);
                beforeRow = await prisma.consumerNumber.create({
                    data: {
                        consumer_number: consumerNumber,
                        user_id: submittingUser.id,
                        type: 'officer_cash',
                        customer_name: submittingUser.full_name,
                        mobile_number: submittingUser.phone || '03000000000',
                        amount_due: 0,
                        billing_month: '2608',
                        due_date: dueDate,
                        bill_status: 'P'
                    }
                });
            }

            const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
            const placeholderRef = `PENDING-${payment_method.toUpperCase()}-${Date.now()}`;

            const claimed = await tryReserveConsumerNumber(consumerNumber, amountFloat, expiresAt, placeholderRef);
            if (!claimed) {
                return res.status(409).json({ success: false, message: 'You already have a pending request for this payment method. Please complete or cancel it before submitting a new one.' });
            }

            // Best-effort: the slot we just claimed was free, meaning any earlier
            // BankDepositRequest tied to it had already expired — mark it rejected
            // so it stops showing as pending anywhere.
            if (beforeRow.cash_submission_ref?.startsWith('BDR-')) {
                const staleId = parseInt(beforeRow.cash_submission_ref.replace('BDR-', ''), 10);
                if (!isNaN(staleId)) {
                    await prisma.bankDepositRequest.updateMany({
                        where: { id: staleId, status: 'pending' },
                        data: { status: 'rejected', description: 'Auto-expired — superseded by a new request.' }
                    });
                }
            }

            let qrImageBase64 = null;
            if (payment_method === 'qr_payment') {
                const outletDisplayName = submittingUser.outlet?.name ? `${submittingUser.outlet.name} (${submittingUser.full_name})` : submittingUser.full_name;
                const dqr = await generateDqr({
                    consumerNumber,
                    consumerDetail: outletDisplayName,
                    amount: amountFloat,
                    cellNo: submittingUser.phone || '03000000000',
                    referenceInfo: `BDR-OUTLET-${outletId || 'HQ'}-${Date.now()}`
                });
                if (!dqr.success) {
                    // Roll back the reservation exactly to its prior state.
                    await prisma.consumerNumber.update({
                        where: { consumer_number: consumerNumber },
                        data: {
                            amount_due: beforeRow.amount_due,
                            bill_status: beforeRow.bill_status,
                            due_date: beforeRow.due_date,
                            cash_submission_ref: beforeRow.cash_submission_ref
                        }
                    });
                    return res.status(502).json({ success: false, message: dqr.message || 'Failed to generate QR code.' });
                }
                qrImageBase64 = dqr.qrImageBase64;
            }

            const methodPrefix = payment_method === '1bill' ? '1B' : 'QR';
            const generatedVoucherId = `VCH-${methodPrefix}-${Date.now().toString().slice(-6)}`;
            const generatedTransactionId = `${methodPrefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

            deposit = await prisma.bankDepositRequest.create({
                data: {
                    amount: amountFloat,
                    payment_method,
                    receipt_id: receipt_id || generatedVoucherId,
                    transaction_id: generatedTransactionId,
                    status: 'pending',
                    outlet_id: outletId,
                    submitted_by_id: req.user.id,
                    accountant_id: null,
                    consumer_number: consumerNumber,
                    qr_image_base64: qrImageBase64,
                    expires_at: expiresAt,
                    created_at: now()   // ✅ explicit created_at
                }
            });

            await prisma.consumerNumber.update({
                where: { consumer_number: consumerNumber },
                data: { cash_submission_ref: `BDR-${deposit.id}` }
            });

            if (outletId) {
                await updateCashRegisterOnDeposit(outletId, amountFloat);
            }
        } else {
            // manual_deposit — same as before, plus a self-generated transaction_id
            const manualTransactionId = `MD-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
            const manualVoucherId = `VCH-MD-${Date.now().toString().slice(-6)}`;
            deposit = await prisma.$transaction(async (tx) => {
                const newDeposit = await tx.bankDepositRequest.create({
                    data: {
                        amount: amountFloat,
                        bank_account_id: bank_account_id ? parseInt(bank_account_id) : null,
                        payment_method,
                        receipt_id: receipt_id || manualVoucherId,
                        receipt_photo_url,
                        description,
                        status: 'pending',
                        outlet_id: outletId,
                        submitted_by_id: req.user.id,
                        transaction_id: manualTransactionId,
                        created_at: now()   // ✅ explicit created_at
                    }
                });

                if (outletId) {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);

                    let register = await tx.cashRegister.findFirst({
                        where: { outlet_id: outletId, date: { gte: today } }
                    });

                    if (register) {
                        await tx.cashRegister.update({
                            where: { id: register.id },
                            data: {
                                cash_transferred_out: register.cash_transferred_out + amountFloat,
                                closing_cash: register.closing_cash - amountFloat
                            }
                        });
                    } else {
                        await tx.cashRegister.create({
                            data: {
                                outlet_id: outletId,
                                date: today,
                                opening_cash: 0,
                                cash_transferred_out: amountFloat,
                                closing_cash: -Math.abs(amountFloat)
                            }
                        });
                    }
                }

                return newDeposit;
            });
        }

        await logAction(req, 'BANK_DEPOSIT_SUBMITTED', `Deposit request of PKR ${amount} submitted via ${payment_method}.`, deposit.id, 'BankDepositRequest');

        res.json({ success: true, message: 'Deposit request submitted successfully.', deposit });
    } catch (error) {
        console.error('submitBankDeposit error:', error);
        res.status(500).json({ success: false, message: 'Error submitting deposit request.', error: error.message });
    }
};

/**
 * cancelBankDeposit
 * The submitting outlet retracts their own still-pending request. For
 * 1bill/qr_payment, also immediately releases the accountant's reserved
 * consumer number (bill_status back to 'P'/free) instead of waiting for the
 * 24h expiry — so another outlet can use that accountant right away.
 */
const cancelBankDeposit = async (req, res) => {
    try {
        const { id } = req.params;
        const deposit = await prisma.bankDepositRequest.findUnique({ where: { id: parseInt(id) } });
        if (!deposit) return res.status(404).json({ success: false, message: 'Deposit request not found.' });
        if (deposit.submitted_by_id !== req.user.id) {
            return res.status(403).json({ success: false, message: 'You can only cancel your own requests.' });
        }
        if (deposit.status !== 'pending') {
            return res.status(400).json({ success: false, message: `Cannot cancel a request that is already ${deposit.status}.` });
        }

        const updated = await prisma.bankDepositRequest.update({
            where: { id: deposit.id },
            data: { status: 'cancelled' }
        });

        if (deposit.consumer_number) {
            await prisma.consumerNumber.updateMany({
                where: { consumer_number: deposit.consumer_number, cash_submission_ref: `BDR-${deposit.id}` },
                data: { bill_status: 'P', amount_due: 0, cash_submission_ref: null, updated_at: now() }
            });
        }

        await logAction(req, 'BANK_DEPOSIT_CANCELLED', `Deposit request #${id} cancelled by outlet.`, deposit.id, 'BankDepositRequest');
        res.json({ success: true, message: 'Deposit request cancelled.', deposit: updated });
    } catch (error) {
        console.error('cancelBankDeposit error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

/**
 * updateCashRegisterOnDeposit
 * Same daybook bump submitBankDeposit already does for manual deposits,
 * extracted so the 1bill/qr_payment branch (which doesn't otherwise need a
 * transaction) can apply it too, keeping outlet cash-register behavior
 * identical across all three payment methods.
 */
const updateCashRegisterOnDeposit = async (outletId, amountFloat) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const register = await prisma.cashRegister.findFirst({
        where: { outlet_id: outletId, date: { gte: today } }
    });

    if (register) {
        await prisma.cashRegister.update({
            where: { id: register.id },
            data: {
                cash_transferred_out: register.cash_transferred_out + amountFloat,
                closing_cash: register.closing_cash - amountFloat
            }
        });
    } else {
        await prisma.cashRegister.create({
            data: {
                outlet_id: outletId,
                date: today,
                opening_cash: 0,
                cash_transferred_out: amountFloat,
                closing_cash: -Math.abs(amountFloat)
            }
        });
    }
};

/**
 * listBankDeposits
 * List deposit requests (filtered by status or outlet).
 */
const listBankDeposits = async (req, res) => {
    try {
        const { status, outlet_id } = req.query;
        let where = {};
        if (status) where.status = status;
        if (outlet_id) where.outlet_id = parseInt(outlet_id);

        // If an outlet user, only show their own outlet's requests
        if (req.user.role_id !== 1 && req.user.role_id !== 2 && req.user.outlet_id) {
             where.outlet_id = req.user.outlet_id;
        }

        const deposits = await prisma.bankDepositRequest.findMany({
            where,
            include: {
                submitted_by: { select: { id: true, full_name: true, username: true } },
                verified_by: { select: { id: true, full_name: true, username: true } },
                bank_account: { select: { id: true, bank_name: true, account_number: true } },
                outlet: { select: { id: true, name: true, code: true } },
                accountant: { select: { id: true, full_name: true } }
            },
            orderBy: { created_at: 'desc' }
        });

        res.json({ success: true, data: deposits });
    } catch (error) {
        console.error('listBankDeposits error:', error);
        res.status(500).json({ success: false, message: 'Error fetching deposit requests.', error: error.message });
    }
};

/**
 * verifyBankDeposit
 * Accounts office verifies the deposit. Automatically creates a bank ledger transaction.
 */
const verifyBankDeposit = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, remarks } = req.body; // status: "verified" or "rejected"

        if (!['verified', 'rejected'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status.' });
        }

        const deposit = await prisma.bankDepositRequest.findUnique({ where: { id: parseInt(id) } });
        if (!deposit) return res.status(404).json({ success: false, message: 'Deposit request not found.' });
        if (deposit.status !== 'pending') return res.status(400).json({ success: false, message: `Deposit is already ${deposit.status}.` });

        if (status === 'verified') {
            if (!deposit.bank_account_id) {
                return res.status(400).json({ success: false, message: 'Cannot verify without a destination bank_account_id. Please update the request first.' });
            }

            // Transaction: Update deposit status, Add Bank Transaction, Update Bank Account Balance
            const result = await prisma.$transaction(async (tx) => {
                const account = await tx.bankAccount.findUnique({ where: { id: deposit.bank_account_id } });
                const balanceAfter = account.current_balance + deposit.amount;

                const txn = await tx.bankTransaction.create({
                    data: {
                        bank_account_id: account.id,
                        type: 'credit',
                        amount: deposit.amount,
                        balance_after: balanceAfter,
                        description: `Deposit Verified (ID: ${deposit.id}): ${deposit.description || ''}`,
                        reference: deposit.receipt_id,
                        transaction_date: deposit.created_at, // or now()
                        created_by_id: req.user.id
                    }
                });

                await tx.bankAccount.update({
                    where: { id: account.id },
                    data: { current_balance: balanceAfter }
                });

                const updatedDeposit = await tx.bankDepositRequest.update({
                    where: { id: deposit.id },
                    data: {
                        status: 'verified',
                        verified_by_id: req.user.id,
                        bank_transaction_id: txn.id,
                        description: remarks ? `${deposit.description || ''}\nVerify Remarks: ${remarks}` : deposit.description
                    }
                });
                
                return updatedDeposit;
            });
            
            await logAction(req, 'BANK_DEPOSIT_VERIFIED', `Deposit request #${id} verified. Credited PKR ${deposit.amount}.`, deposit.id, 'BankDepositRequest');
            res.json({ success: true, message: 'Deposit verified and bank ledger updated.', deposit: result });

        } else if (status === 'rejected') {
            const updatedDeposit = await prisma.bankDepositRequest.update({
                where: { id: parseInt(id) },
                data: {
                    status: 'rejected',
                    verified_by_id: req.user.id,
                    description: remarks ? `${deposit.description || ''}\nReject Remarks: ${remarks}` : deposit.description
                }
            });
            await logAction(req, 'BANK_DEPOSIT_REJECTED', `Deposit request #${id} rejected.`, deposit.id, 'BankDepositRequest');
            res.json({ success: true, message: 'Deposit request rejected.', deposit: updatedDeposit });
        }

    } catch (error) {
        console.error('verifyBankDeposit error:', error);
        res.status(500).json({ success: false, message: 'Error verifying deposit.', error: error.message });
    }
};

module.exports = {
    getBankAccounts,
    getBankBalanceSummary,
    createBankAccount,
    updateBankAccount,
    getBankAccountLedger,
    recordBankTransaction,
    uploadBankStatement,
    getBankStatements,
    reconcileTransactions,
    getReconciliationStatus,
    createInterBankTransfer,
    submitBankDeposit,
    listBankDeposits,
    verifyBankDeposit,
    listAccountantsForDeposit,
    cancelBankDeposit
};
