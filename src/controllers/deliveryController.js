const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Submit Delivery (Batch Upload)
const submitDelivery = async (req, res) => {
  const { order_id } = req.body;
  
  if (!order_id) {
    return res.status(400).json({
      success: false,
      error: { code: 400, message: 'order_id is required' }
    });
  }

  try {
    // Check if order exists and is assigned to the current user
    const order = await prisma.order.findUnique({
      where: { 
        id: parseInt(order_id),
        delivery_officer_id: req.user.id
      },
      include: { delivery: true }
    });
    
    if (!order) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Order not found or not assigned to you' }
      });
    }
    
    if (order.delivery) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'Delivery already submitted for this order' }
      });
    }

    // Process files and tags
    const facePhotos = req.files['face_photos'] || [];
    const locationPhotos = req.files['location_photos'] || [];
    const housePhotos = req.files['house_photos'] || [];
    
    const faceTags = req.body.face_tags ? JSON.parse(req.body.face_tags) : [];
    const locationTags = req.body.location_tags ? JSON.parse(req.body.location_tags) : [];
    const houseTags = req.body.house_tags ? JSON.parse(req.body.house_tags) : [];
    const locationLinks = req.body.location_links ? JSON.parse(req.body.location_links) : [];
    const linkTags = req.body.link_tags ? JSON.parse(req.body.link_tags) : [];

    // Validate counts
    if (facePhotos.length > 1 || locationPhotos.length > 1 || housePhotos.length > 1 || locationLinks.length > 1) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'Maximum 1 items per type allowed' }
      });
    }

    // Create delivery
    const delivery = await prisma.delivery.create({
      data: {
        order_id: parseInt(order_id),
        delivery_agent_id: req.user.id,
        status: 'completed',
        start_time: new Date(),
        end_time: new Date(),
        verified: true
      }
    });

    // Create uploads
    const uploadsData = [];

    // Face photos
    facePhotos.forEach((file, index) => {
      uploadsData.push({
        delivery_id: delivery.id,
        upload_type: 'face_photo',
        file_url: file.url,
        tag: faceTags[index] || null,
        uploaded_at: new Date()
      });
    });

    // Location photos
    locationPhotos.forEach((file, index) => {
      uploadsData.push({
        delivery_id: delivery.id,
        upload_type: 'location_photo',
        file_url: file.url,
        tag: locationTags[index] || null,
        uploaded_at: new Date()
      });
    });

    // House photos
    housePhotos.forEach((file, index) => {
      uploadsData.push({
        delivery_id: delivery.id,
        upload_type: 'house_photo',
        file_url: file.url,
        tag: houseTags[index] || null,
        uploaded_at: new Date()
      });
    });

    // Location links
    locationLinks.forEach((link, index) => {
      uploadsData.push({
        delivery_id: delivery.id,
        upload_type: 'location_link',
        link: link,
        tag: linkTags[index] || null,
        uploaded_at: new Date()
      });
    });

    if (uploadsData.length > 0) {
      await prisma.deliveryUpload.createMany({
        data: uploadsData
      });
    }

    // Update order status
    await prisma.order.update({
      where: { id: parseInt(order_id) },
      data: { status: 'delivered' }
    });

    // Fetch updated delivery
    const updatedDelivery = await prisma.delivery.findUnique({
      where: { id: delivery.id },
      include: {
        delivery_agent: {
          select: { full_name: true, username: true }
        },
        uploads: true
      }
    });
    
    return res.status(201).json({
      success: true,
      message: 'Delivery submitted successfully',
      data: { delivery: updatedDelivery }
    });
  } catch (error) {
    console.error('Submit delivery error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Get Delivery by Order ID
const getDeliveryByOrderId = async (req, res) => {
  const { order_id } = req.params;
  
  try {
    const delivery = await prisma.delivery.findUnique({
      where: { order_id: parseInt(order_id) },
      include: {
        delivery_agent: {
          select: { full_name: true, username: true }
        },
        uploads: true
      }
    });
    
    if (!delivery) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Delivery not found for this order' }
      });
    }
    
    // Check authorization: delivery agent or admin/assigned
    if (delivery.delivery_agent_id !== req.user.id && req.user.role.name !== 'Admin') {
      return res.status(403).json({
        success: false,
        error: { code: 403, message: 'Not authorized' }
      });
    }
    
    return res.status(200).json({
      success: true,
      data: { delivery }
    });
  } catch (error) {
    console.error('Get delivery by order error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

module.exports = {
  submitDelivery,
  getDeliveryByOrderId
};