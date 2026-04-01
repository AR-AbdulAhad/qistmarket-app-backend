const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const createComplaint = async (req, res) => {
  try {
    const { customer_name, customer_cnic, mobile_number, description } = req.body;

    if (!customer_name || !mobile_number || !description) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'customer_name, mobile_number, and description are required.' },
      });
    }

    const complaintId = `CMP-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${Math.floor(1000 + Math.random() * 9000)}`;

    const complaint = await prisma.complaint.create({
      data: {
        complaint_id: complaintId,
        customer_name: customer_name.trim(),
        customer_cnic: customer_cnic ? customer_cnic.trim() : null,
        mobile_number: mobile_number.trim(),
        description: description.trim(),
        created_by_user_id: req.user?.id || null,
      },
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
    const { status = 'open', page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const where = {};
    if (status) {
      const statusList = status.split(',').map((s) => s.trim());
      if (statusList.length > 1) {
        where.status = { in: statusList };
      } else {
        where.status = statusList[0];
      }
    }

    const [complaints, total] = await prisma.$transaction([
      prisma.complaint.findMany({
        where,
        orderBy: { created_at: 'desc' },
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

module.exports = {
  createComplaint,
  getComplaints,
};
