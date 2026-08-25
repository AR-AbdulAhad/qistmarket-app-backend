const prisma = require('../../lib/prisma');
const { sendOrderStatusNotification, sendDeliveryOfficerHandover } = require('../services/watiService');
const { updateCsrRanking } = require('../services/rankingService');

// Helper for current timestamp
const now = () => new Date();

/**
 * Logs a status change for an order and sends a WhatsApp notification via Wati.
 * 
 * @param {number} order_id The ID of the order being changed
 * @param {string|null} old_status The previous status
 * @param {string} new_status The new status
 * @param {object} user The user object making the change (req.user)
 * @param {string|null} remarks Optional remarks for the audit trail
 */
async function logOrderStatusChange(order_id, old_status, new_status, user, remarks = null, skipNotification = false) {
  try {
    if (old_status === new_status && !remarks) return;

    // Fetch order details with necessary relations for the message and audit
    const freshOrder = await prisma.order.findUnique({
      where: { id: parseInt(order_id) },
      select: {
        id: true,
        whatsapp_number: true,
        customer_name: true,
        product_name: true,
        order_ref: true,
        cancelled_reason: true,
        postponed_feedback: true,
        assigned_to: { select: { full_name: true } },
        delivery_officer: { select: { full_name: true, phone: true } },
        recovery_officer: { select: { full_name: true } },
        outlet: { select: { name: true } },
        verification: { include: { purchaser: true } },
      }
    });

    if (!freshOrder) return;

    // Auto-generate remarks if not provided
    let finalRemarks = remarks;
    if (!finalRemarks) {
      if (new_status.toLowerCase() === 'transferred' && freshOrder.outlet) {
        finalRemarks = `Transferred to ${freshOrder.outlet.name}`;
      } else if (new_status.toLowerCase() === 'pending' && freshOrder.assigned_to) {
        finalRemarks = `Assigned to ${freshOrder.assigned_to.full_name} for Verification`;
      } else if (new_status.toLowerCase() === 'picked' && freshOrder.delivery_officer) {
        finalRemarks = `Assigned to ${freshOrder.delivery_officer.full_name} for Delivery`;
      }
    }

    await prisma.orderStatusHistory.create({
      data: {
        order_id: parseInt(order_id),
        old_status: old_status || null,
        new_status: new_status,
        user_id: user?.id ? parseInt(user.id) : null,
        role_name: user?.role || user?.role_name || null,
        remarks: finalRemarks,
        created_at: now(),   // ✅ explicit timestamp (previously new Date())
      }
    });

    // ─── Wati Notification Logic ─────────────────────────────────────────────
    
    if (skipNotification || !freshOrder.whatsapp_number) return;

    let message = "";
    const customerName = freshOrder.customer_name;
    const orderRef = freshOrder.order_ref;

    switch (new_status.toLowerCase()) {
      case 'picked':
        if (freshOrder.delivery_officer) {
          const customerPhone = freshOrder.verification?.purchaser?.telephone_number || freshOrder.whatsapp_number;
          if (customerPhone) {
            sendDeliveryOfficerHandover(customerPhone, {
              customerName: freshOrder.verification?.purchaser?.name || freshOrder.customer_name,
              itemName: freshOrder.product_name,
              orderRef: freshOrder.order_ref,
              deliveryOfficerName: freshOrder.delivery_officer.full_name,
              deliveryOfficerNumber: freshOrder.delivery_officer.phone || 'N/A',
            }).catch(err => console.error('[WATI] Delivery Officer Handover Error:', err));
          }
        }
        // Note: Dedicated WATI_DELIVERY_OFFICER_HANDOVER_TEMPLATE sent above, no generic message needed.
        break;

      case 'postponed':
        message = `Aapka order ${orderRef} postpone kar diya gaya hai. Wajah: ${freshOrder.postponed_feedback || 'N/A'}. Hum isay baad mein process karenge.`;
        break;

      case 'expired':
        message = `Aapka order ${orderRef} expire ho chuka hai. Agar aap isay dubara khulwana chahte hain to hamari website visit karein ya support se raabta karein.`;
        break;

      default:
        // Statuses with dedicated WATI templates (new, pending, in_progress, transferred, approved, completed, delivered, cancelled)
        // are handled by customerNotificationService / watiService dedicated functions to avoid sending generic legacy templates.
        break;
    }

    if (message) {
      // Send notification asynchronously without waiting
      sendOrderStatusNotification(freshOrder.whatsapp_number, {
        customerName: `Assalam-o-Alaikum ${customerName}!`,
        message: message
      }).catch(err => console.error('[WATI] Notification Error:', err));
    }

    // Trigger CSR Ranking Update on specific status changes that affect scores
    if (['delivered', 'completed', 'cancelled', 'expired'].includes(new_status.toLowerCase())) {
        const orderForRanking = await prisma.order.findUnique({
            where: { id: parseInt(order_id) },
            select: { created_by_user_id: true }
        });
        if (orderForRanking?.created_by_user_id) {
            updateCsrRanking(orderForRanking.created_by_user_id, 'month').catch(err => console.error('Ranking update error:', err));
            updateCsrRanking(orderForRanking.created_by_user_id, 'today').catch(err => console.error('Ranking update error:', err));
        }
    }

  } catch (error) {
    console.error('Failed to log order status change or send notification:', error);
  }
}

module.exports = {
  logOrderStatusChange
};