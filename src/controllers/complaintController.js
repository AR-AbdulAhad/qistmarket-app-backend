const prisma = require('../../lib/prisma');
const { sendComplaintReceived, sendComplaintResolved, sendComplaintAssigned } = require('../services/watiService');

// Helper for current timestamp
const now = () => new Date();

// Name/phone/designation for a staff member being referenced in a customer-facing
// message — designation prefers the real job title (Employee.designation) over the
// system login role, falling back to the role name when no employee profile exists.
async function getUserDisplayInfo(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      employee_profile: { select: { designation: true } },
      role: { select: { name: true } },
    },
  });
  if (!user) return null;
  return {
    name: user.full_name,
    number: user.phone,
    designation: user.employee_profile?.designation || user.role?.name,
  };
}

// Fires the "complaint_assigned" WATI message — shared by pickComplaint (officer
// self-assigns) and updateComplaint (admin/CSR assigns to someone else).
async function notifyComplaintAssigned(complaint, assignedUserId) {
  try {
    const assignedUser = await getUserDisplayInfo(assignedUserId);
    if (!assignedUser) return;

    await sendComplaintAssigned(complaint.mobile_number, {
      customerName: complaint.customer_name,
      complaintId: complaint.complaint_id,
      assignedUserName: assignedUser.name,
      assignedUserNumber: assignedUser.number,
      assignedUserDesignation: assignedUser.designation,
      complaintDate: new Date(complaint.created_at).toLocaleDateString('en-PK'),
      trackingLink: complaint.complaint_id,
    });
  } catch (e) {
    console.error('[complaintController] notifyComplaintAssigned error:', e);
  }
}

// Fires the "complaint_resolved" WATI message — the resolving staff member's
// details come from whoever is making this request (req.user), since only they
// can be the one marking it Solved.
async function notifyComplaintResolved(complaint, resolutionNote, resolvedByUserId) {
  try {
    const resolvedBy = resolvedByUserId ? await getUserDisplayInfo(resolvedByUserId) : null;
    const resolvedAt = now();

    await sendComplaintResolved(complaint.mobile_number, {
      customerName: complaint.customer_name,
      complaintId: complaint.complaint_id,
      complaintSubject: complaint.description,
      resolutionRemarks: resolutionNote || 'Resolved gracefully',
      solvedByName: resolvedBy?.name,
      solvedByNumber: resolvedBy?.number,
      solvedByDesignation: resolvedBy?.designation,
      resolvedDate: resolvedAt.toLocaleDateString('en-PK'),
      resolvedTime: resolvedAt.toLocaleTimeString('en-PK'),
      trackingLink: complaint.complaint_id,
    });
  } catch (e) {
    console.error('[complaintController] notifyComplaintResolved error:', e);
  }
}

const createComplaint = async (req, res) => {
  try {
    const { customer_name, customer_cnic, mobile_number, description } = req.body;

    if (!customer_name || !customer_cnic || !mobile_number || !description) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'customer_name, customer_cnic, mobile_number, and description are required.' },
      });
    }

    // Note: Fixed complaintId generation (original had invalid replace)
    const dateStr = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    const complaintId = `CMP-${dateStr}-${Math.floor(1000 + Math.random() * 9000)}`;

    // Build media URLs from uploaded files
    let mediaUrls = [];
    if (req.files && req.files.length > 0) {
      mediaUrls = req.files.map((file) => file.url).filter(Boolean);
    } else if (req.file) {
      mediaUrls = [req.file.url].filter(Boolean);
    }

    const complaint = await prisma.complaint.create({
      data: {
        complaint_id: complaintId,
        customer_name: customer_name.trim(),
        customer_cnic: customer_cnic ? customer_cnic.trim() : null,
        mobile_number: mobile_number.trim(),
        description: description.trim(),
        media_urls: mediaUrls.length > 0 ? mediaUrls : null,
        created_by_user_id: req.user?.id || null,
        status: 'New',
        created_at: now(),   // ✅ explicit created_at
        updated_at: now()    // ✅ explicit updated_at
      },
    });

    // Notify customer — "SELF" for all Complaint_By_* fields when the customer
    // registered it themselves via the public endpoint (no logged-in staff user).
    await sendComplaintReceived(mobile_number, {
      customerName: customer_name.trim(),
      complaintId: complaintId,
      complaintDate: now().toLocaleDateString('en-PK'),
      complaintByName: req.user?.full_name || 'SELF',
      complaintByNumber: req.user?.phone || 'SELF',
      complaintByDesignation: req.user?.role || 'SELF',
      trackingLink: complaintId,
    });

    return res.status(201).json({
      success: true,
      message: 'Complaint recorded successfully.',
      data: { complaint },
    });
  } catch (error) {
    console.error('Create complaint error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const getComplaints = async (req, res) => {
  try {
    const { status, tab, page = 1, limit = 20, search = '', my_only } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const where = {};

    // Tab-based filtering
    if (tab === 'unassigned') {
      where.assigned_to_user_id = null;
      where.status = { not: 'Solved' };
    } else if (tab === 'picked') {
      where.assigned_to_user_id = req.user?.id;
      where.status = { not: 'Solved' };
    } else if (tab === 'solved') {
      where.status = 'Solved';
    } else if (status) {
      const statusList = status.split(',').map((s) => s.trim());
      if (statusList.length > 1) {
        where.status = { in: statusList };
      } else {
        where.status = statusList[0];
      }
    }
    
    if (search) {
      const q = search.trim();
      where.OR = [
        { complaint_id: { contains: q } },
        { mobile_number: { contains: q } },
        { customer_name: { contains: q } },
        { customer_cnic: { contains: q } }
      ];
    }
    
    if (my_only === 'true') {
      where.created_by_user_id = req.user?.id;
    }

    const [complaints, total] = await prisma.$transaction([
      prisma.complaint.findMany({
        where,
        orderBy: { created_at: 'desc' },
        include: {
          created_by: { select: { id: true, full_name: true, role: { select: { name: true } } } },
          assigned_to: { select: { id: true, full_name: true } }
        },
        skip,
        take,
      }),
      prisma.complaint.count({ where }),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        complaints,
        pagination: {
          page: Number(page),
          limit: take,
          total,
          totalPages: Math.ceil(total / take),
          hasNext: skip + take < total,
          hasPrev: Number(page) > 1,
        },
      },
    });
  } catch (error) {
    console.error('Get complaints error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const updateComplaint = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, resolution_note, assigned_to_user_id } = req.body;

    const existing = await prisma.complaint.findUnique({ where: { id: Number(id) } });
    if (!existing) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'Complaint not found.' } });
    }

    // Restriction: Only CSR (or Super Admin) can mark as Solved
    if (status === 'Solved' && existing.status !== 'Solved') {
      const userRole = req.user?.role;
      if (userRole !== 'Sales Officer' && userRole !== 'Super Admin' && userRole !== 'Admin' && userRole !== 'CSR') {
        return res.status(403).json({
          success: false,
          error: { code: 403, message: 'Only authorized staff can resolve complaints.' }
        });
      }
    }

    const updateData = {
      updated_at: now()   // ✅ explicit updated_at
    };
    if (status) updateData.status = status;
    if (resolution_note !== undefined) updateData.resolution_note = resolution_note;
    if (assigned_to_user_id !== undefined) updateData.assigned_to_user_id = assigned_to_user_id;

    const complaint = await prisma.complaint.update({
      where: { id: Number(id) },
      data: updateData,
    });

    if (status === 'Solved' && existing.status !== 'Solved') {
      notifyComplaintResolved(existing, resolution_note, req.user?.id);
    }

    if (assigned_to_user_id && assigned_to_user_id !== existing.assigned_to_user_id) {
      notifyComplaintAssigned(complaint, assigned_to_user_id);
    }

    return res.status(200).json({
      success: true,
      message: 'Complaint updated successfully.',
      data: { complaint },
    });
  } catch (error) {
    console.error('Update complaint error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const pickComplaint = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const existing = await prisma.complaint.findUnique({ where: { id: Number(id) } });
    if (!existing) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'Complaint not found.' } });
    }

    if (existing.assigned_to_user_id) {
      return res.status(400).json({ success: false, error: { code: 400, message: 'Complaint already assigned.' } });
    }

    const complaint = await prisma.complaint.update({
      where: { id: Number(id) },
      data: {
        assigned_to_user_id: userId,
        status: 'Assigned',
        updated_at: now()   // ✅ explicit updated_at
      },
    });

    notifyComplaintAssigned(complaint, userId);

    return res.status(200).json({
      success: true,
      message: 'Complaint picked successfully.',
      data: { complaint },
    });
  } catch (error) {
    console.error('Pick complaint error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const searchPurchasers = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 3) {
      return res.status(200).json({ success: true, data: [] });
    }

    const purchasers = await prisma.purchaserVerification.findMany({
      where: {
        OR: [
          { cnic_number: { contains: q } },
          { name: { contains: q } }
        ]
      },
      take: 10,
      select: {
        id: true,
        name: true,
        cnic_number: true,
        telephone_number: true,
      }
    });

    return res.status(200).json({
      success: true,
      data: purchasers
    });
  } catch (error) {
    console.error('Search purchasers error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

// ─── GET /complaint — public complaint submission form (no auth) ──────────────
// This is the page https://app.qistmarket.pk/complaint is supposed to be — it was
// hardcoded as a link/button in several WATI templates (order booking, verification
// officer assigned, verification started, account awareness) but no page existed
// here for it, so every tap 404'd. Submits to the existing POST /api/complaints/public.

const complaintFormPage = (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="ur" dir="ltr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>Complaint Register — Qist Market</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, 'Segoe UI', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background: #f1f5f9; color: #0f172a; padding: 16px; }
    .wrapper { max-width: 520px; margin: 0 auto; }
    .card { background: #fff; border-radius: 22px; padding: 1.4rem; box-shadow: 0 1px 3px rgba(0,0,0,0.05), 0 10px 20px -5px rgba(0,0,0,0.03); }
    h1 { font-size: 1.1rem; font-weight: 800; color: #dc2626; margin-bottom: 4px; }
    .sub { font-size: 0.72rem; color: #64748b; margin-bottom: 20px; }
    label { display: block; font-size: 0.68rem; font-weight: 700; text-transform: uppercase; color: #6c86a3; margin: 14px 0 6px; }
    input, textarea { width: 100%; border: 1.5px solid #e2e8f0; border-radius: 14px; padding: 11px 14px; font-size: 0.9rem; font-family: inherit; color: #0f172a; }
    input:focus, textarea:focus { outline: none; border-color: #dc2626; }
    textarea { resize: vertical; min-height: 90px; }
    input[type="file"] { border: none; padding: 6px 0; font-size: 0.8rem; }
    .btn { width: 100%; margin-top: 20px; background: #dc2626; color: #fff; border: none; padding: 13px; border-radius: 60px; font-weight: 800; font-size: 0.9rem; cursor: pointer; }
    .btn:disabled { opacity: 0.6; cursor: default; }
    .err { color: #dc2626; font-size: 0.78rem; margin-top: 10px; display: none; }
    .success { display: none; text-align: center; }
    .success .tick { font-size: 2.2rem; margin-bottom: 8px; }
    .success h2 { font-size: 1.05rem; font-weight: 800; color: #15803d; margin-bottom: 10px; }
    .success .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f1f5f9; font-size: 0.85rem; }
    .success .row span:first-child { color: #6c86a3; font-weight: 700; text-transform: uppercase; font-size: 0.65rem; }
    .success a.track { display: block; margin-top: 16px; color: #dc2626; font-weight: 700; font-size: 0.85rem; text-decoration: none; }
    .footer { text-align: center; font-size: 0.68rem; color: #94a3b8; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="card">
      <div id="formView">
        <h1>Complaint Register Karein</h1>
        <div class="sub">Qist Market Support — apni complaint darj karwayein</div>

        <form id="complaintForm">
          <label>Name</label>
          <input type="text" name="customer_name" required />

          <label>CNIC</label>
          <input type="text" name="customer_cnic" placeholder="42101-1234567-1" required />

          <label>Mobile Number</label>
          <input type="tel" name="mobile_number" placeholder="03XX-XXXXXXX" required />

          <label>Complaint Details</label>
          <textarea name="description" required></textarea>

          <label>Attachments (optional)</label>
          <input type="file" name="media" accept="image/*" multiple />

          <button class="btn" type="submit">Submit Complaint</button>
          <div class="err" id="errMsg"></div>
        </form>
      </div>

      <div class="success" id="successView">
        <div class="tick">✅</div>
        <h2>Complaint Registered!</h2>
        <div class="row"><span>Complaint ID</span><span id="outComplaintId"></span></div>
        <p style="font-size:0.8rem;color:#64748b;margin-top:12px;">Hamari team 24 hours mein aap se rabta karegi.</p>
        <a class="track" id="outTrackLink" href="#" target="_blank" rel="noopener">Complaint Track Karein →</a>
      </div>
    </div>
    <div class="footer">Har Cheez Qist Par!</div>
  </div>

  <script>
    document.getElementById('complaintForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var form = e.target;
      var btn = form.querySelector('.btn');
      var errEl = document.getElementById('errMsg');
      errEl.style.display = 'none';
      btn.disabled = true;
      btn.textContent = 'Bhej rahe hain...';

      try {
        var res = await fetch('/api/complaints/public', { method: 'POST', body: new FormData(form) });
        var data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error((data && data.error && data.error.message) || 'Complaint submit nahi ho saki.');
        }
        var complaintId = data.data.complaint.complaint_id;
        document.getElementById('outComplaintId').textContent = complaintId;
        document.getElementById('outTrackLink').href = '/api/complaints/track/' + encodeURIComponent(complaintId);
        document.getElementById('formView').style.display = 'none';
        document.getElementById('successView').style.display = 'block';
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Submit Complaint';
      }
    });
  </script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(html);
};

// ─── GET /api/complaints/track/:complaintId — public tracking page (no auth) ──
// Linked from the WATI "complaint_received" message's Complaint_Tracking_Link.

const COMPLAINT_STATUS_STYLES = {
  new: { label: 'New', color: '#b45309', bg: '#fef3c7' },
  assigned: { label: 'In Progress', color: '#1d4ed8', bg: '#dbeafe' },
  'in progress': { label: 'In Progress', color: '#1d4ed8', bg: '#dbeafe' },
  solved: { label: 'Resolved', color: '#15803d', bg: '#dcfce7' },
  resolved: { label: 'Resolved', color: '#15803d', bg: '#dcfce7' },
};

const complaintStatusMeta = (status) => {
  const key = (status || '').toLowerCase();
  return COMPLAINT_STATUS_STYLES[key] || { label: status || 'N/A', color: '#475569', bg: '#f1f5f9' };
};

const escapeHtml = (str) =>
  String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const renderComplaintTrackingPage = (complaint) => {
  const statusMeta = complaintStatusMeta(complaint?.status);
  const createdAt = complaint
    ? new Date(complaint.created_at).toLocaleDateString('en-PK', { day: '2-digit', month: 'short', year: 'numeric' })
    : 'N/A';
  const updatedAt = complaint
    ? new Date(complaint.updated_at).toLocaleDateString('en-PK', { day: '2-digit', month: 'short', year: 'numeric' })
    : 'N/A';

  const bodyHtml = complaint
    ? `
      <div class="row"><span class="label">Complaint ID</span><span class="val">${escapeHtml(complaint.complaint_id)}</span></div>
      <div class="row"><span class="label">Status</span><span class="pill" style="background:${statusMeta.bg};color:${statusMeta.color};">${escapeHtml(statusMeta.label)}</span></div>
      <div class="row"><span class="label">Registered On</span><span class="val">${createdAt}</span></div>
      <div class="row"><span class="label">Last Updated</span><span class="val">${updatedAt}</span></div>
      <div class="row block"><span class="label">Description</span><span class="val">${escapeHtml(complaint.description)}</span></div>
      ${complaint.resolution_note ? `<div class="row block"><span class="label">Resolution Note</span><span class="val">${escapeHtml(complaint.resolution_note)}</span></div>` : ''}
    `
    : `<p class="not-found">Complaint nahi mili. Meherbani karke Complaint ID check karein ya Qist Market support se rabta karein.</p>`;

  return `<!DOCTYPE html>
<html lang="ur" dir="ltr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>Complaint Tracking — Qist Market</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, 'Segoe UI', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background: #f1f5f9; color: #0f172a; padding: 16px; }
    .wrapper { max-width: 520px; margin: 0 auto; }
    .card { background: #fff; border-radius: 22px; padding: 1.4rem; box-shadow: 0 1px 3px rgba(0,0,0,0.05), 0 10px 20px -5px rgba(0,0,0,0.03); }
    h1 { font-size: 1.05rem; font-weight: 800; color: #dc2626; margin-bottom: 4px; }
    .sub { font-size: 0.72rem; color: #64748b; margin-bottom: 18px; }
    .row { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 10px 0; border-bottom: 1px solid #f1f5f9; }
    .row.block { flex-direction: column; gap: 4px; }
    .label { font-size: 0.65rem; font-weight: 700; text-transform: uppercase; color: #6c86a3; white-space: nowrap; }
    .val { font-size: 0.85rem; font-weight: 600; color: #1e293b; text-align: right; word-break: break-word; }
    .row.block .val { text-align: left; font-weight: 500; }
    .pill { display: inline-block; padding: 3px 12px; border-radius: 30px; font-size: 0.68rem; font-weight: 800; }
    .not-found { font-size: 0.85rem; color: #64748b; padding: 10px 0; }
    .footer { text-align: center; font-size: 0.68rem; color: #94a3b8; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="card">
      <h1>Complaint Tracking</h1>
      <div class="sub">Qist Market Support</div>
      ${bodyHtml}
    </div>
    <div class="footer">Har Cheez Qist Par!</div>
  </div>
</body>
</html>`;
};

const trackComplaint = async (req, res) => {
  try {
    const { complaintId } = req.params;
    const complaint = await prisma.complaint.findUnique({ where: { complaint_id: complaintId } });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(complaint ? 200 : 404).send(renderComplaintTrackingPage(complaint));
  } catch (error) {
    console.error('Track complaint error:', error);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(500).send(renderComplaintTrackingPage(null));
  }
};

module.exports = {
  createComplaint,
  getComplaints,
  updateComplaint,
  pickComplaint,
  searchPurchasers,
  trackComplaint,
  complaintFormPage,
};