const fs = require('fs');
const file = 'c:/Users/pc/Desktop/Qist Software/qistmarket-app-dashboard/src/components/common/DeliveredProductDetails.tsx';
let content = fs.readFileSync(file, 'utf8');

const startIdx = content.indexOf('{/* Payment Details Section */}');
let endIdx = content.indexOf('{/* No Data Message */}');
if (startIdx === -1 || endIdx === -1) {
    console.log('Could not find boundaries');
    process.exit(1);
}

let paymentDetailsJSX = content.substring(startIdx, endIdx);
paymentDetailsJSX = paymentDetailsJSX.replace(/deliveredProduct\.payment_details/g, 'paymentDetails');
paymentDetailsJSX = paymentDetailsJSX.replace(/\{paymentDetails && \(/, ''); 
paymentDetailsJSX = paymentDetailsJSX.replace(/Payment Details/, '{title}');

const lastDivIdx = paymentDetailsJSX.lastIndexOf('</div>');
paymentDetailsJSX = paymentDetailsJSX.substring(0, lastDivIdx + 6);
const closingBraceIdx = paymentDetailsJSX.lastIndexOf(')}');
if (closingBracdIdx !== -1) {
    paymentDetailsJSX = paymentDetailsJSX.substring(0, closingBracdIdx);
}


const componentDef = `
const PaymentDetailsSection = ({ paymentDetails, title = "Payment Details" }: { paymentDetails: any, title?: string }) => {
    const [expandedInstallments, setExpandedInstallments] = useState(true);

    if (!paymentDetails) return null;

    return (
        <div className="mb-6">
            <h3 className="mb-3 flex items-center gap-2 text-lg font-semibold text-dark dark:text-white">
                <svg className="h-5 w-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2z" />
                </svg>
                {title}
            </h3>

            {/* Advance Payment */}
            {paymentDetails.advance_payment && (
` + paymentDetailsJSX.substring(paymentDetailsJSX.indexOf('<div className="mb-4 rounded-lg border border-stroke bg-gray-50 p-4"')) + `
    );
};`

const insertIdx = content.indexOf('export default function DeliveredProductDetails');
content = content.substring(0, insertIdx) + componentDef + '\n' + content.substring(insertIdx);


const oldBlockFull = content.substring(content.indexOf('{/* Payment Details Section */}'), content.indexOf('{/* No Data Message */}'));
content = content.replace(oldBlockFull, `{/* Payment Details Section */}
                <PaymentDetailsSection 
                    paymentDetails={deliveredProduct.payment_details} 
                    title="Payment Details (Current Delivery)" 
                />
                `);

const searchStr = '{ad.uploads && ad.uploads.length > 0 &&';
const archivedUploadsIdx = content.indexOf(searchStr);
if (archivedUploadsIdx !== -1) {
    const blockToInsert = `
                                {/* Archived Payment Details */}
                                <PaymentDetailsSection 
                                    paymentDetails={ad.payment_details} 
                                    title="Payment Details (Archived Delivery)" 
                                />
`
    content = content.replace(searchStr, blockToInsert + '                                ' + searchStr);
}

content = content.replace('const [expandedInstallments, setExpandedInstallments] = useState(true);\n', '');

fs.writeFileSync(file, content);
console.log('Success');

