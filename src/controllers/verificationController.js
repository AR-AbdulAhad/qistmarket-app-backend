const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Start Verification
const startVerification = async (req, res) => {
  const { order_id } = req.body;
  
  try {
    // Check if verification already exists
    const existingVerification = await prisma.verification.findUnique({
      where: { order_id: parseInt(order_id) }
    });
    
    if (existingVerification) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'Verification already started for this order' }
      });
    }
    
    // Check if order exists
    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) }
    });
    
    if (!order) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Order not found' }
      });
    }
    
    // Create verification
    const verification = await prisma.verification.create({
      data: {
        order_id: parseInt(order_id),
        verification_officer_id: req.user.id,
        status: 'in_progress',
        start_time: new Date()
      },
      include: {
        order: true,
        verification_officer: {
          select: { full_name: true, username: true }
        }
      }
    });
    
    return res.status(201).json({
      success: true,
      message: 'Verification started successfully',
      data: { verification }
    });
  } catch (error) {
    console.error('Start verification error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Save Purchaser Verification (updated with nearest_location)
const savePurchaserVerification = async (req, res) => {
  const { verification_id } = req.params;
  const {
    name,
    father_husband_name,
    present_address,
    permanent_address,
    nearest_location, // NEW FIELD
    cnic_number,
    telephone_number,
    employer_name,
    employer_address,
    designation,
    official_number,
    years_in_company,
    gross_salary
  } = req.body;
  
  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) }
    });
    
    if (!verification) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Verification not found' }
      });
    }
    
    // Check if purchaser already exists
    const existingPurchaser = await prisma.purchaserVerification.findUnique({
      where: { verification_id: parseInt(verification_id) }
    });
    
    let purchaser;
    if (existingPurchaser) {
      // Update existing
      purchaser = await prisma.purchaserVerification.update({
        where: { verification_id: parseInt(verification_id) },
        data: {
          name,
          father_husband_name,
          present_address,
          permanent_address,
          nearest_location,
          cnic_number,
          telephone_number,
          employer_name,
          employer_address,
          designation,
          official_number,
          years_in_company,
          gross_salary,
          is_verified: true
        }
      });
    } else {
      // Create new
      purchaser = await prisma.purchaserVerification.create({
        data: {
          verification_id: parseInt(verification_id),
          name,
          father_husband_name,
          present_address,
          permanent_address,
          nearest_location,
          cnic_number,
          telephone_number,
          employer_name,
          employer_address,
          designation,
          official_number,
          years_in_company,
          gross_salary,
          is_verified: true
        }
      });
    }
    
    return res.status(200).json({
      success: true,
      message: 'Purchaser verification saved successfully',
      data: { purchaser }
    });
  } catch (error) {
    console.error('Save purchaser error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Save Grantor Verification (updated with nearest_location)
const saveGrantorVerification = async (req, res) => {
  const { verification_id, grantor_number } = req.params;
  const {
    name,
    father_husband_name,
    present_address,
    permanent_address,
    nearest_location, // NEW FIELD
    cnic_number,
    telephone_number,
    designation,
    official_number,
    office_address,
    company_name,
    years_in_company,
    monthly_income,
    full_residential_address,
    relationship
  } = req.body;
  
  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) }
    });
    
    if (!verification) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Verification not found' }
      });
    }
    
    const grantorNum = parseInt(grantor_number);
    if (grantorNum !== 1 && grantorNum !== 2) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'Grantor number must be 1 or 2' }
      });
    }
    
    let grantor;
    
    // Upsert grantor
    const existingGrantor = await prisma.grantorVerification.findFirst({
      where: {
        verification_id: parseInt(verification_id),
        grantor_number: grantorNum
      }
    });
    
    if (existingGrantor) {
      grantor = await prisma.grantorVerification.update({
        where: { 
          verification_id_grantor_number: {
            verification_id: parseInt(verification_id),
            grantor_number: grantorNum
          }
        },
        data: {
          name,
          father_husband_name,
          present_address,
          permanent_address,
          nearest_location, // NEW FIELD
          cnic_number,
          telephone_number,
          designation,
          official_number,
          office_address,
          company_name,
          years_in_company,
          monthly_income,
          full_residential_address,
          relationship,
          is_verified: true
        }
      });
    } else {
      grantor = await prisma.grantorVerification.create({
        data: {
          verification_id: parseInt(verification_id),
          grantor_number: grantorNum,
          name,
          father_husband_name,
          present_address,
          permanent_address,
          nearest_location, // NEW FIELD
          cnic_number,
          telephone_number,
          designation,
          official_number,
          office_address,
          company_name,
          years_in_company,
          monthly_income,
          full_residential_address,
          relationship,
          is_verified: true
        }
      });
    }
    
    return res.status(200).json({
      success: true,
      message: `Grantor ${grantorNum} verification saved successfully`,
      data: { grantor }
    });
  } catch (error) {
    console.error('Save grantor error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Save Next of Kin
const saveNextOfKin = async (req, res) => {
  const { verification_id } = req.params;
  const {
    name,
    cnic_number,
    relation,
    phone_number
  } = req.body;
  
  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) }
    });
    
    if (!verification) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Verification not found' }
      });
    }
    
    let nextOfKin;
    
    const existing = await prisma.nextOfKinVerification.findUnique({
      where: { verification_id: parseInt(verification_id) }
    });
    
    if (existing) {
      nextOfKin = await prisma.nextOfKinVerification.update({
        where: { verification_id: parseInt(verification_id) },
        data: { name, cnic_number, relation, phone_number }
      });
    } else {
      nextOfKin = await prisma.nextOfKinVerification.create({
        data: {
          verification_id: parseInt(verification_id),
          name,
          cnic_number,
          relation,
          phone_number
        }
      });
    }
    
    return res.status(200).json({
      success: true,
      message: 'Next of kin saved successfully',
      data: { next_of_kin: nextOfKin }
    });
  } catch (error) {
    console.error('Save next of kin error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Save Location Tracking
const saveLocation = async (req, res) => {
  const { verification_id } = req.params;
  const {
    latitude,
    longitude,
    accuracy,
    label
  } = req.body;
  
  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) }
    });
    
    if (!verification) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Verification not found' }
      });
    }
    
    const location = await prisma.locationTracking.create({
      data: {
        verification_id: parseInt(verification_id),
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        accuracy: accuracy ? parseFloat(accuracy) : null,
        label,
        timestamp: new Date()
      }
    });
    
    return res.status(201).json({
      success: true,
      message: 'Location saved successfully',
      data: { location }
    });
  } catch (error) {
    console.error('Save location error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// NEW: Save Verification Location with photos
const saveVerificationLocation = async (req, res) => {
  const { verification_id } = req.params;
  const {
    location_type,
    latitude,
    longitude,
    address,
    label,
    person_type,
    person_id
  } = req.body;

  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) }
    });

    if (!verification) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Verification not found' }
      });
    }

    // Create location first
    const location = await prisma.verificationLocation.create({
      data: {
        verification_id: parseInt(verification_id),
        location_type,
        latitude: latitude ? parseFloat(latitude) : null,
        longitude: longitude ? parseFloat(longitude) : null,
        address,
        label,
        person_type,
        person_id: person_id ? parseInt(person_id) : null,
        created_at: new Date()
      }
    });

    // Get uploaded photos (up to 5)
    const photos = req.files || [];
    
    // Save photos to separate table
    const photoPromises = photos.map(file => 
      prisma.verificationLocationPhoto.create({
        data: {
          verification_location_id: location.id,
          file_url: file.url,
          uploaded_at: new Date()
        }
      })
    );

    const savedPhotos = await Promise.all(photoPromises);

    // Get location with photos
    const locationWithPhotos = await prisma.verificationLocation.findUnique({
      where: { id: location.id },
      include: {
        photos: true
      }
    });

    return res.status(201).json({
      success: true,
      message: 'Location saved successfully',
      data: { location: locationWithPhotos }
    });
  } catch (error) {
    console.error('Save verification location error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// NEW: Get Verification Locations
const getVerificationLocations = async (req, res) => {
  const { verification_id } = req.params;
  
  try {
    const locations = await prisma.verificationLocation.findMany({
      where: { verification_id: parseInt(verification_id) },
      include: {
        photos: true
      },
      orderBy: { created_at: 'desc' }
    });

    return res.status(200).json({
      success: true,
      data: { locations }
    });
  } catch (error) {
    console.error('Get verification locations error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// NEW: Delete Verification Location
const deleteVerificationLocation = async (req, res) => {
  const { location_id } = req.params;
  
  try {
    const location = await prisma.verificationLocation.findUnique({
      where: { id: parseInt(location_id) },
      include: { photos: true }
    });

    if (!location) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Location not found' }
      });
    }

    // Check permission
    const verification = await prisma.verification.findUnique({
      where: { id: location.verification_id }
    });

    if (verification.verification_officer_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: { code: 403, message: 'Not authorized to delete this location' }
      });
    }

    // Delete photos first (cascade delete would be better if configured)
    await prisma.verificationLocationPhoto.deleteMany({
      where: { verification_location_id: parseInt(location_id) }
    });

    // Delete location
    await prisma.verificationLocation.delete({
      where: { id: parseInt(location_id) }
    });

    return res.status(200).json({
      success: true,
      message: 'Location deleted successfully'
    });
  } catch (error) {
    console.error('Delete verification location error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Upload Purchaser Document
const uploadPurchaserDocument = async (req, res) => {
  const { verification_id } = req.params;
  const { document_type } = req.body;
  
  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) },
      include: { purchaser: true }
    });
    
    if (!verification) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Verification not found' }
      });
    }
    
    if (!verification.purchaser) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'Purchaser verification not found' }
      });
    }
    
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'No file uploaded' }
      });
    }
    
    // Save document in documents table
    const document = await prisma.verificationDocument.create({
      data: {
        verification_id: parseInt(verification_id),
        document_type,
        person_type: 'purchaser',
        person_id: verification.purchaser.id,
        file_url: req.file.url,
        label: `${document_type} - Purchaser`,
        uploaded_at: new Date()
      }
    });
    
    // Also update the purchaser record with specific URL
    let updateData = {};
    if (document_type === 'cnic_front') {
      updateData.cnic_front_url = req.file.url;
    } else if (document_type === 'cnic_back') {
      updateData.cnic_back_url = req.file.url;
    } else if (document_type === 'utility_bill') {
      updateData.utility_bill_url = req.file.url;
    } else if (document_type === 'service_card') {
      updateData.service_card_url = req.file.url;
    } else if (document_type === 'signature') {
      updateData.signature_url = req.file.url;
    }
    
    if (Object.keys(updateData).length > 0) {
      await prisma.purchaserVerification.update({
        where: { verification_id: parseInt(verification_id) },
        data: updateData
      });
    }
    
    return res.status(201).json({
      success: true,
      message: 'Document uploaded successfully',
      data: { document }
    });
  } catch (error) {
    console.error('Upload purchaser document error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Upload Grantor Document
const uploadGrantorDocument = async (req, res) => {
  const { verification_id, grantor_number } = req.params;
  const { document_type } = req.body;
  
  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) },
      include: {
        grantors: {
          where: { grantor_number: parseInt(grantor_number) }
        }
      }
    });
    
    if (!verification) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Verification not found' }
      });
    }
    
    const grantor = verification.grantors[0];
    if (!grantor) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'Grantor not found' }
      });
    }
    
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'No file uploaded' }
      });
    }
    
    // Save document in documents table
    const document = await prisma.verificationDocument.create({
      data: {
        verification_id: parseInt(verification_id),
        document_type,
        person_type: `grantor${grantor_number}`,
        person_id: grantor.id,
        file_url: req.file.url,
        label: `${document_type} - Grantor ${grantor_number}`,
        uploaded_at: new Date()
      }
    });
    
    // Also update the grantor record with specific URL
    let updateData = {};
    if (document_type === 'cnic_front') {
      updateData.cnic_front_url = req.file.url;
    } else if (document_type === 'cnic_back') {
      updateData.cnic_back_url = req.file.url;
    } else if (document_type === 'utility_bill') {
      updateData.utility_bill_url = req.file.url;
    } else if (document_type === 'service_card') {
      updateData.service_card_url = req.file.url;
    } else if (document_type === 'signature') {
      updateData.signature_url = req.file.url;
    }
    
    if (Object.keys(updateData).length > 0) {
      await prisma.grantorVerification.update({
        where: { 
          verification_id_grantor_number: {
            verification_id: parseInt(verification_id),
            grantor_number: parseInt(grantor_number)
          }
        },
        data: updateData
      });
    }
    
    return res.status(201).json({
      success: true,
      message: 'Document uploaded successfully',
      data: { document }
    });
  } catch (error) {
    console.error('Upload grantor document error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Upload Photo
const uploadPhoto = async (req, res) => {
  const { verification_id } = req.params;
  const { person_type, person_id, label } = req.body;
  
  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) }
    });
    
    if (!verification) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Verification not found' }
      });
    }
    
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'No file uploaded' }
      });
    }
    
    const document = await prisma.verificationDocument.create({
      data: {
        verification_id: parseInt(verification_id),
        document_type: 'photo',
        person_type,
        person_id: person_id ? parseInt(person_id) : null,
        file_url: req.file.url,
        label: label || `Photo - ${person_type}`,
        uploaded_at: new Date()
      }
    });
    
    return res.status(201).json({
      success: true,
      message: 'Photo uploaded successfully',
      data: { document }
    });
  } catch (error) {
    console.error('Upload photo error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Upload Signature
const uploadSignature = async (req, res) => {
  const { verification_id } = req.params;
  const { person_type, person_id } = req.body;
  
  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) }
    });
    
    if (!verification) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Verification not found' }
      });
    }
    
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'No file uploaded' }
      });
    }
    
    // Save document
    const document = await prisma.verificationDocument.create({
      data: {
        verification_id: parseInt(verification_id),
        document_type: 'signature',
        person_type,
        person_id: person_id ? parseInt(person_id) : null,
        file_url: req.file.url,
        label: `Signature - ${person_type}`,
        uploaded_at: new Date()
      }
    });
    
    // Update respective person's signature URL
    if (person_type === 'purchaser' && person_id) {
      await prisma.purchaserVerification.update({
        where: { id: parseInt(person_id) },
        data: { signature_url: req.file.url }
      });
    } else if (person_type.startsWith('grantor') && person_id) {
      await prisma.grantorVerification.update({
        where: { id: parseInt(person_id) },
        data: { signature_url: req.file.url }
      });
    }
    
    return res.status(201).json({
      success: true,
      message: 'Signature uploaded successfully',
      data: { document }
    });
  } catch (error) {
    console.error('Upload signature error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Delete Document
const deleteDocument = async (req, res) => {
  const { document_id } = req.params;
  
  try {
    const document = await prisma.verificationDocument.findUnique({
      where: { id: parseInt(document_id) }
    });
    
    if (!document) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Document not found' }
      });
    }
    
    // Check if user has permission to delete this document
    const verification = await prisma.verification.findUnique({
      where: { id: document.verification_id }
    });
    
    if (verification.verification_officer_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: { code: 403, message: 'Not authorized to delete this document' }
      });
    }
    
    // Delete document
    await prisma.verificationDocument.delete({
      where: { id: parseInt(document_id) }
    });
    
    return res.status(200).json({
      success: true,
      message: 'Document deleted successfully'
    });
  } catch (error) {
    console.error('Delete document error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Complete Verification
const completeVerification = async (req, res) => {
  const { verification_id } = req.params;
  
  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) },
      include: {
        purchaser: true,
        grantors: true,
        nextOfKin: true,
        documents: true,
        locations: true,
        verification_locations: {
          include: {
            photos: true
          }
        }
      }
    });
    
    if (!verification) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Verification not found' }
      });
    }
    
    // Check if all required data is present
    if (!verification.purchaser) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'Purchaser verification is required' }
      });
    }
    
    // Check minimum documents requirement
    const cnicFrontCount = verification.documents.filter(d => d.document_type === 'cnic_front').length;
    const cnicBackCount = verification.documents.filter(d => d.document_type === 'cnic_back').length;
    const signatureCount = verification.documents.filter(d => d.document_type === 'signature').length;
    
    if (cnicFrontCount < 3 || cnicBackCount < 3 || signatureCount < 3) {
      return res.status(400).json({
        success: false,
        error: { 
          code: 400, 
          message: 'Minimum 3 CNIC front, 3 CNIC back, and 3 signature copies are required' 
        }
      });
    }
    
    // Update verification status
    const updatedVerification = await prisma.verification.update({
      where: { id: parseInt(verification_id) },
      data: {
        status: 'completed',
        end_time: new Date(),
      },
      include: {
        order: true,
        verification_officer: {
          select: { full_name: true, username: true }
        },
        purchaser: true,
        grantors: true,
        nextOfKin: true,
        locations: true,
        verification_locations: {
          include: {
            photos: true
          }
        },
        documents: true
      }
    });
    
    return res.status(200).json({
      success: true,
      message: 'Verification completed successfully',
      data: { verification: updatedVerification }
    });
  } catch (error) {
    console.error('Complete verification error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Get Verification by Order ID (updated with verification_locations)
const getVerificationByOrderId = async (req, res) => {
  const { order_id } = req.params;
  
  try {
    const verification = await prisma.verification.findUnique({
      where: { order_id: parseInt(order_id) },
      include: {
        verification_officer: {
          select: { full_name: true, username: true }
        },
        purchaser: true,
        grantors: true,
        nextOfKin: true,
        locations: true,
        verification_locations: {
          include: {
            photos: true
          }
        },
        documents: true,
        // ── IMPORTANT: This is what was missing ────────────────────────
        reviews: {
          include: {
            reviewer: {
              select: {
                id: true,           // useful for frontend checks if needed
                full_name: true,
                username: true
              }
            }
          }
        }
        // ───────────────────────────────────────────────────────────────
      }
    });
    
    if (!verification) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Verification not found for this order' }
      });
    }
    
    return res.status(200).json({
      success: true,
      data: { verification }
    });
  } catch (error) {
    console.error('Get verification by order error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

// Submit Verification Review
const submitVerificationReview = async (req, res) => {
  const { verification_id } = req.params;
  const { approved, remarks } = req.body;
  
  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) },
      include: { reviews: true }
    });
    
    if (!verification) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Verification not found' }
      });
    }
    
    if (verification.status !== 'completed') {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'Verification must be completed before review' }
      });
    }

    // Check if maximum reviews reached
    if (verification.reviews.length >= 3) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'Maximum of 3 reviews allowed' }
      });
    }

    // Check if user already reviewed
    const existingReview = verification.reviews.find(r => r.reviewer_id === req.user.id);
    if (existingReview) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'You have already reviewed this verification' }
      });
    }
    
    // Create review
    const review = await prisma.verificationReview.create({
      data: {
        verification_id: parseInt(verification_id),
        reviewer_id: req.user.id,
        approved: approved === 'true' || approved === true,
        remarks
      }
    });

    // Fetch updated reviews
    const updatedVerification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) },
      include: { reviews: true }
    });

    const approves = updatedVerification.reviews.filter(r => r.approved).length;
    const rejects = updatedVerification.reviews.filter(r => !r.approved).length;

    let newStatus = verification.status;
    if (approves >= 2) {
      newStatus = 'approved';
    } else if (rejects >= 2) {
      newStatus = 'rejected';
    }

    if (newStatus !== verification.status) {
      await prisma.verification.update({
        where: { id: parseInt(verification_id) },
        data: { status: newStatus }
      });
    }
    
    return res.status(200).json({
      success: true,
      message: `Review submitted successfully`,
      data: { review }
    });
  } catch (error) {
    console.error('Submit verification review error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' }
    });
  }
};

const getVerifications = async (req, res) => {
  const { page = 1, limit = 10, search = '', sortBy = 'created_at', sortDir = 'desc', ...filters } = req.query;

  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  try {
    const where = {};

    if (search.trim()) {
      where.OR = [
        { order: { customer_name: { contains: search } } },
        { order: { whatsapp_number: { contains: search } } },
        { order: { order_ref: { contains: search } } },
        { order: { token_number: { contains: search } } },
        { order: { product_name: { contains: search } } },
        { order: { city: { contains: search } } },
        { order: { area: { contains: search } } },
      ];
    }

    Object.entries(filters).forEach(([key, value]) => {
      if (value) {
        if (key === 'status') {
          where.status = value;
        } else if (key === 'verification_officer_id') {
          where.verification_officer_id = parseInt(value);
        }
      }
    });

    const verifications = await prisma.verification.findMany({
      where,
      skip,
      take,
      orderBy: { [sortBy]: sortDir },
      include: {
        order: true,
        verification_officer: {
          select: { full_name: true, username: true }
        },
        purchaser: true,
        grantors: true,
      },
    });

    const total = await prisma.verification.count({ where });

    return res.status(200).json({
      success: true,
      data: {
        verifications,
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
    console.error(error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

module.exports = {
  getVerifications,
  startVerification,
  savePurchaserVerification,
  saveGrantorVerification,
  saveNextOfKin,
  saveLocation,
  saveVerificationLocation, // NEW
  getVerificationLocations, // NEW
  deleteVerificationLocation, // NEW
  uploadPurchaserDocument,
  uploadGrantorDocument,
  uploadPhoto,
  uploadSignature,
  deleteDocument,
  completeVerification,
  getVerificationByOrderId,
  submitVerificationReview
};