const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { notifyAdmins } = require('../utils/notificationUtils');

// Start Verification
const startVerification = async (req, res) => {
  const { order_id } = req.body;

  try {
    const existingVerification = await prisma.verification.findUnique({
      where: { order_id: parseInt(order_id) }
    });

    if (existingVerification) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'Verification already started for this order' }
      });
    }

    const order = await prisma.order.findUnique({
      where: { id: parseInt(order_id) }
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: { code: 404, message: 'Order not found' }
      });
    }

    const verification = await prisma.verification.create({
      data: {
        order_id: parseInt(order_id),
        verification_officer_id: req.user.id,
        status: 'in_progress',
        start_time: new Date()
      },
      include: {
        order: { select: { order_ref: true } },
        verification_officer: { select: { full_name: true, username: true } }
      }
    });

    await prisma.order.update({
      where: { id: parseInt(order_id) },
      data: {
        status: 'in_progress',
        updated_at: new Date(),
      }
    });


    // Create empty purchaser
    const purchaser = await prisma.purchaserVerification.create({
      data: {
        verification_id: verification.id,
        name: '',
        father_husband_name: '',
        present_address: '',
        permanent_address: '',
        nearest_location: '',
        cnic_number: '',
        telephone_number: '',
        employment_type: 'EMPLOYED',
        job_type: null,
        employer_name: '',
        employer_address: '',
        designation: '',
        official_number: null,
        years_in_company: null,
        gross_salary: null,
        business_name: null,
        established_since: null,
        business_address: null,
        net_income: null,
        service_card_url: null,
        signature_url: null,
        is_verified: false
      }
    });

    // Grantor 1
    const grantor1 = await prisma.grantorVerification.create({
      data: {
        verification_id: verification.id,
        grantor_number: 1,
        name: '',
        father_husband_name: '',
        present_address: '',
        permanent_address: '',
        nearest_location: '',
        cnic_number: '',
        telephone_number: '',
        employment_type: 'EMPLOYED',
        job_type: null,
        designation: '',
        official_number: null,
        office_address: '',
        company_name: null,
        years_in_company: null,
        monthly_income: null,
        business_name: null,
        established_since: null,
        business_address: null,
        net_income: null,
        full_residential_address: '',
        relationship: '',
        service_card_url: null,
        signature_url: null,
        is_verified: false
      }
    });

    // Grantor 2
    const grantor2 = await prisma.grantorVerification.create({
      data: {
        verification_id: verification.id,
        grantor_number: 2,
        name: '',
        father_husband_name: '',
        present_address: '',
        permanent_address: '',
        nearest_location: '',
        cnic_number: '',
        telephone_number: '',
        employment_type: 'EMPLOYED',
        job_type: null,
        designation: '',
        official_number: null,
        office_address: '',
        company_name: null,
        years_in_company: null,
        monthly_income: null,
        business_name: null,
        established_since: null,
        business_address: null,
        net_income: null,
        full_residential_address: '',
        relationship: '',
        service_card_url: null,
        signature_url: null,
        is_verified: false
      }
    });

    const io = req.app.get('io');
    await notifyAdmins(
      'Verification Started',
      `Visit started for Order #${verification.order.order_ref} by ${verification.verification_officer.full_name}`,
      'verification_start',
      verification.id,
      io
    );

    return res.status(201).json({
      success: true,
      message: 'Verification started successfully',
      data: {
        verification,
        purchaser: { id: purchaser.id },
        grantor1: { id: grantor1.id },
        grantor2: { id: grantor2.id }
      }
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
    present_zone,
    present_area,
    present_block,
    present_street,
    present_house_no,
    present_period_of_stay,
    permanent_address,
    permanent_zone,
    permanent_area,
    permanent_block,
    permanent_street,
    permanent_house_no,
    permanent_period_of_stay,
    nearest_location,
    cnic_number,
    telephone_number,
    employment_type,
    job_type,
    employer_name,
    employer_address,
    designation,
    official_number,
    years_in_company,
    gross_salary,
    business_name,
    established_since,
    business_address,
    net_income
  } = req.body;

  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) }
    });

    if (!verification) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'Verification not found' } });
    }

    const data = {
      name: name || '',
      father_husband_name: father_husband_name || '',
      present_address: present_address || '',
      present_zone: present_zone || null,
      present_area: present_area || null,
      present_block: present_block || null,
      present_street: present_street || null,
      present_house_no: present_house_no || null,
      present_period_of_stay: present_period_of_stay || null,
      permanent_address: permanent_address || '',
      permanent_zone: permanent_zone || null,
      permanent_area: permanent_area || null,
      permanent_block: permanent_block || null,
      permanent_street: permanent_street || null,
      permanent_house_no: permanent_house_no || null,
      permanent_period_of_stay: permanent_period_of_stay || null,
      nearest_location: nearest_location || '',
      cnic_number: cnic_number || '',
      telephone_number: telephone_number || '',
      employment_type: employment_type || 'EMPLOYED',
      job_type: job_type || null,
      is_verified: true
    };

    if (employment_type === 'SELF_EMPLOYED') {
      data.business_name = business_name || null;
      data.established_since = established_since || null;
      data.business_address = business_address || null;
      data.net_income = net_income || null;

      data.employer_name = null;
      data.employer_address = null;
      data.designation = null;
      data.official_number = null;
      data.years_in_company = null;
      data.gross_salary = null;
    } else {
      data.employer_name = employer_name || null;
      data.employer_address = employer_address || null;
      data.designation = designation || null;
      data.official_number = official_number || null;
      data.years_in_company = years_in_company || null;
      data.gross_salary = gross_salary || null;

      data.business_name = null;
      data.established_since = null;
      data.business_address = null;
      data.net_income = null;
    }

    const purchaser = await prisma.purchaserVerification.upsert({
      where: { verification_id: parseInt(verification_id) },
      update: data,
      create: {
        verification_id: parseInt(verification_id),
        ...data
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Purchaser verification saved successfully',
      data: { purchaser }
    });
  } catch (error) {
    console.error('Save purchaser error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

// Save Grantor Verification (updated with nearest_location)
const saveGrantorVerification = async (req, res) => {
  const { verification_id, grantor_number } = req.params;
  const {
    name,
    father_husband_name,
    present_address,
    present_zone,
    present_area,
    present_block,
    present_street,
    present_house_no,
    present_period_of_stay,
    permanent_address,
    permanent_zone,
    permanent_area,
    permanent_block,
    permanent_street,
    permanent_house_no,
    permanent_period_of_stay,
    nearest_location,
    cnic_number,
    telephone_number,
    employment_type,
    job_type,
    designation,
    official_number,
    office_address,
    company_name,
    years_in_company,
    monthly_income,
    business_name,
    established_since,
    business_address,
    net_income,
    full_residential_address,
    relationship
  } = req.body;

  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) }
    });

    if (!verification) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'Verification not found' } });
    }

    const grantorNum = parseInt(grantor_number);
    if (grantorNum !== 1 && grantorNum !== 2) {
      return res.status(400).json({ success: false, error: { code: 400, message: 'Grantor number must be 1 or 2' } });
    }

    const data = {
      name: name || '',
      father_husband_name: father_husband_name || '',
      present_address: present_address || '',
      present_zone: present_zone || null,
      present_area: present_area || null,
      present_block: present_block || null,
      present_street: present_street || null,
      present_house_no: present_house_no || null,
      present_period_of_stay: present_period_of_stay || null,
      permanent_address: permanent_address || '',
      permanent_zone: permanent_zone || null,
      permanent_area: permanent_area || null,
      permanent_block: permanent_block || null,
      permanent_street: permanent_street || null,
      permanent_house_no: permanent_house_no || null,
      permanent_period_of_stay: permanent_period_of_stay || null,
      nearest_location: nearest_location || '',
      cnic_number: cnic_number || '',
      telephone_number: telephone_number || '',
      office_address: office_address || '',
      full_residential_address: full_residential_address || '',
      relationship: relationship || '',
      employment_type: employment_type || 'EMPLOYED',
      job_type: job_type || null,
      is_verified: true
    };

    if (employment_type === 'SELF_EMPLOYED') {
      data.business_name = business_name || null;
      data.established_since = established_since || null;
      data.business_address = business_address || null;
      data.net_income = net_income || null;

      data.designation = null;
      data.official_number = null;
      data.company_name = null;
      data.years_in_company = null;
      data.monthly_income = null;
    } else {
      data.designation = designation || null;
      data.official_number = official_number || null;
      data.company_name = company_name || null;
      data.years_in_company = years_in_company || null;
      data.monthly_income = monthly_income || null;

      data.business_name = null;
      data.established_since = null;
      data.business_address = null;
      data.net_income = null;
    }

    let grantor;

    const existing = await prisma.grantorVerification.findFirst({
      where: {
        verification_id: parseInt(verification_id),
        grantor_number: grantorNum
      }
    });

    if (existing) {
      grantor = await prisma.grantorVerification.update({
        where: {
          verification_id_grantor_number: {
            verification_id: parseInt(verification_id),
            grantor_number: grantorNum
          }
        },
        data
      });
    } else {
      grantor = await prisma.grantorVerification.create({
        data: {
          verification_id: parseInt(verification_id),
          grantor_number: grantorNum,
          ...data
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
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
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
    if (!req.file) {
      return res.status(400).json({ success: false, error: { code: 400, message: 'No file uploaded' } });
    }

    const purchaser = await prisma.purchaserVerification.findUnique({
      where: { verification_id: parseInt(verification_id) }
    });

    if (!purchaser) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'Purchaser record not found' } });
    }

    const document = await prisma.verificationDocument.create({
      data: {
        verification_id: parseInt(verification_id),
        document_type,
        person_type: 'purchaser',
        person_id: purchaser.id,
        file_url: req.file.url,
        label: `${document_type} - Purchaser`,
        uploaded_at: new Date()
      }
    });

    let updateData = {};
    if (document_type === 'cnic_front') updateData.cnic_front_url = req.file.url;
    if (document_type === 'cnic_back') updateData.cnic_back_url = req.file.url;
    if (document_type === 'utility_bill') updateData.utility_bill_url = req.file.url;
    if (document_type === 'service_card') updateData.service_card_url = req.file.url;
    if (document_type === 'signature') updateData.signature_url = req.file.url;

    if (Object.keys(updateData).length > 0) {
      await prisma.purchaserVerification.update({
        where: { id: purchaser.id },
        data: updateData
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Purchaser document uploaded successfully',
      data: { document }
    });
  } catch (error) {
    console.error('Upload purchaser document error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

// Upload Grantor Document
const uploadGrantorDocument = async (req, res) => {
  const { verification_id, grantor_number } = req.params;
  const { document_type } = req.body;

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: { code: 400, message: 'No file uploaded' } });
    }

    const grantor = await prisma.grantorVerification.findFirst({
      where: {
        verification_id: parseInt(verification_id),
        grantor_number: parseInt(grantor_number)
      }
    });

    if (!grantor) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'Grantor record not found' } });
    }

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

    let updateData = {};
    if (document_type === 'cnic_front') updateData.cnic_front_url = req.file.url;
    if (document_type === 'cnic_back') updateData.cnic_back_url = req.file.url;
    if (document_type === 'utility_bill') updateData.utility_bill_url = req.file.url;
    if (document_type === 'service_card') updateData.service_card_url = req.file.url;
    if (document_type === 'signature') updateData.signature_url = req.file.url;

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
      message: `Grantor ${grantor_number} document uploaded successfully`,
      data: { document }
    });
  } catch (error) {
    console.error('Upload grantor document error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
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
        verification_locations: { include: { photos: true } }
      }
    });

    if (!verification) {
      return res.status(404).json({ success: false, error: { code: 404, message: 'Verification not found' } });
    }

    if (!verification.purchaser) {
      return res.status(400).json({ success: false, error: { code: 400, message: 'Purchaser record is required' } });
    }

    if (!verification.purchaser.cnic_front_url || !verification.purchaser.cnic_back_url) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'Purchaser CNIC front and back are required' }
      });
    }

    const updatedVerification = await prisma.verification.update({
      where: { id: parseInt(verification_id) },
      data: {
        status: 'completed',
        end_time: new Date()
      },
      include: {
        order: { select: { order_ref: true } },
        verification_officer: { select: { full_name: true, username: true } },
        purchaser: true,
        grantors: true,
        nextOfKin: true,
        locations: true,
        verification_locations: { include: { photos: true } },
        documents: true
      }
    });

    await prisma.order.update({
      where: { id: updatedVerification.order_id },
      data: {
        status: 'completed',
        updated_at: new Date(),
      }
    });

    const io = req.app.get('io');
    await notifyAdmins(
      'Verification Completed',
      `Verification completed for Order #${updatedVerification.order.order_ref}`,
      'verification_complete',
      updatedVerification.id,
      io
    );

    return res.status(200).json({
      success: true,
      message: 'Verification completed successfully',
      data: { verification: updatedVerification }
    });
  } catch (error) {
    console.error('Complete verification error:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

const getVerificationByOrderId = async (req, res) => {
  const { order_id } = req.params;

  try {
    const verification = await prisma.verification.findUnique({
      where: { order_id: parseInt(order_id) },
      include: {
        order: {
          select: {
            id: true,
            order_ref: true,
            status: true
          }
        },
        verification_officer: {
          select: { full_name: true, username: true }
        },
        purchaser: true,
        grantors: true,
        nextOfKin: true,
        locations: true,
        verification_locations: {
          include: { photos: true }
        },
        documents: true,
        reviews: {
          include: {
            reviewer: {
              select: {
                id: true,
                full_name: true,
                username: true
              }
            }
          }
        }
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
      data: {
        verification
      }
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
  let { approved, remarks } = req.body;

  try {
    const verification = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) },
      include: {
        order: { select: { id: true, order_ref: true } },  // we need order.id
        reviews: true
      }
    });

    if (!verification) {
      return res.status(404).json({ success: false, error: 'Verification not found' });
    }

    if (verification.status !== 'completed') {
      return res.status(400).json({
        success: false,
        error: 'Verification must be completed before review'
      });
    }

    if (verification.reviews.length >= 3) {
      return res.status(400).json({
        success: false,
        error: 'Maximum of 3 reviews allowed'
      });
    }

    if (verification.reviews.some(r => r.reviewer_id === req.user.id)) {
      return res.status(400).json({
        success: false,
        error: 'You have already reviewed this verification'
      });
    }

    // Normalize approved value
    approved = approved === 'true' || approved === true;

    let finalRemarks = null;

    if (!approved) {  // Reject case
      if (!remarks || !remarks.trim()) {
        return res.status(400).json({
          success: false,
          error: 'Remarks are required when rejecting'
        });
      }
      finalRemarks = remarks.trim();
    }

    // Create the review
    const review = await prisma.verificationReview.create({
      data: {
        verification_id: parseInt(verification_id),
        reviewer_id: req.user.id,
        approved,
        remarks: finalRemarks,
        created_at: new Date()
      }
    });

    // Reload verification with updated reviews
    const updated = await prisma.verification.findUnique({
      where: { id: parseInt(verification_id) },
      include: {
        reviews: true,
        order: { select: { id: true } }
      }
    });

    const approvesCount = updated.reviews.filter(r => r.approved).length;
    const totalReviews = updated.reviews.length;
    const approvalPercentage = totalReviews > 0 ? Math.round((approvesCount / totalReviews) * 100) : 0;

    let newVerificationStatus = verification.status;

    if (totalReviews === 3) {
      if (approvalPercentage >= 67) {
        newVerificationStatus = 'approved';
      } else if (approvalPercentage <= 33) {
        newVerificationStatus = 'rejected';
      }

    }

    let orderStatusUpdate = null;

    if (newVerificationStatus === 'approved') {
      orderStatusUpdate = 'approved';
    } else if (newVerificationStatus === 'rejected') {
      orderStatusUpdate = 'rejected';
    }

    const updates = [];

    if (newVerificationStatus !== verification.status) {
      updates.push(
        prisma.verification.update({
          where: { id: parseInt(verification_id) },
          data: { status: newVerificationStatus }
        })
      );
    }

    if (orderStatusUpdate && totalReviews === 3) {
      updates.push(
        prisma.order.update({
          where: { id: verification.order.id },
          data: {
            status: orderStatusUpdate,
            updated_at: new Date(),
          }
        })
      );
    }

    if (updates.length > 0) {
      await prisma.$transaction(updates);
    }

    // ── Notification ─────────────────────────────────────────────
    const io = req.app.get('io');
    await notifyAdmins(
      'Review Submitted',
      `Review added to Order #${verification.order.order_ref} → ${newVerificationStatus.toUpperCase()} (${approvalPercentage}%)`,
      'review_submitted',
      parseInt(verification_id),
      io
    );

    return res.status(200).json({
      success: true,
      message: 'Review submitted successfully',
      data: {
        review,
        approvalPercentage,
        totalReviews,
        approvesCount,
        verificationStatus: newVerificationStatus,
        orderStatus: orderStatusUpdate || 'unchanged'
      }
    });

  } catch (error) {
    console.error('Submit review error:', error);
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

const getMyAssignedOrdersCursorPaginated = (targetStatus) => async (req, res) => {
  const officerId = req.user.id;

  const {
    lastId = 0,
    limit = 10,
    search = '',
  } = req.query;

  const take = Number(limit);
  const cursorId = Number(lastId);

  try {
    const baseWhere = {
      assigned_to_user_id: officerId,
      status: targetStatus,
    };

    if (search.trim()) {
      baseWhere.OR = [
        { customer_name: { contains: search } },
        { whatsapp_number: { contains: search } },
        { order_ref: { contains: search } },
        { token_number: { contains: search } },
        { product_name: { contains: search } },
        { city: { contains: search } },
        { area: { contains: search } },
      ];
    }

    const totalCount = await prisma.order.count({
      where: baseWhere,
    });

    const where = { ...baseWhere };
    if (cursorId > 0) {
      where.id = { lt: cursorId };
    }

    const orders = await prisma.order.findMany({
      where,
      take,
      orderBy: { id: 'desc' },
      include: {
        created_by: { select: { username: true, full_name: true } },
        assigned_to: { select: { username: true, full_name: true } },
        verification: {
          select: {
            id: true,
            status: true,
            start_time: true,
            end_time: true,
          }
        },
      },
    });

    let nextLastId = null;
    if (orders.length > 0) {
      nextLastId = orders[orders.length - 1].id;
    }

    const hasMore = orders.length === take;

    return res.status(200).json({
      success: true,
      data: {
        orders,
        pagination: {
          nextLastId,
          hasMore,
          limit: take,
          count: orders.length,
          totalCount,
        },
        currentStatus: targetStatus,
      },
    });
  } catch (error) {
    console.error(`Error fetching ${targetStatus} orders:`, error);
    return res.status(500).json({
      success: false,
      error: { code: 500, message: 'Internal server error' },
    });
  }
};

const getMyCustomersWithOrdersAndLedger = async (req, res) => {
  const now = new Date();
  let startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  let endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  if (req.query.year && req.query.month) {
    const y = parseInt(req.query.year);
    const m = parseInt(req.query.month) - 1;
    if (!isNaN(y) && !isNaN(m) && m >= 0 && m <= 11) {
      startOfMonth = new Date(y, m, 1);
      endOfMonth = new Date(y, m + 1, 1);
    }
  }
  try {
    const orders = await prisma.order.findMany({
      where: {}, // No filters - show all orders globally regardless of status or date
      include: {
        verification: { select: { status: true, start_time: true, end_time: true } },
        delivery: { select: { status: true, end_time: true, verified: true } },
        payments: true,
      },
      orderBy: [{ customer_name: 'asc' }, { created_at: 'desc' }],
    });

    if (orders.length === 0) {
      return res.status(200).json({
        success: true,
        data: { month: startOfMonth.toISOString().slice(0, 7), totalCustomers: 0, totalOrders: 0, paidOrders: 0, pendingOrders: 0, customers: [] },
      });
    }

    const customerMap = new Map();

    for (const order of orders) {
      const key = (order.whatsapp_number || `unknown-${order.id}`).trim();

      if (!customerMap.has(key)) {
        customerMap.set(key, {
          customer: {
            name: order.customer_name,
            whatsapp_number: order.whatsapp_number,
            address: order.address,
            city: order.city,
            area: order.area,
          },
          orders: [],
          ledgerSummary: { totalOrders: 0, paidOrders: 0, pendingOrders: 0, totalAdvanceReceived: 0, totalPendingAmount: 0 },
        });
      }

      const group = customerMap.get(key);

      const isDelivered = order.is_delivered || (order.delivery?.status === 'completed');
      const deliveryDate = isDelivered ? (order.delivery?.end_time || order.updated_at) : null;

      const advanceAmount = order.advance_amount || 0;
      const monthlyAmount = order.monthly_amount || 0;
      const totalMonths = order.months || 0;

      // Actual payments from database
      const dbPayments = order.payments || [];

      const hasPaidAdvance = dbPayments.some(p => p.paymentType === 'advance') || isDelivered;

      let advancePayment = {
        amount: advanceAmount,
        paid: hasPaidAdvance,
        paidAt: dbPayments.find(p => p.paymentType === 'advance')?.paidAt || (isDelivered ? deliveryDate : null),
        status: hasPaidAdvance ? 'paid' : 'pending',
        paidVia: dbPayments.find(p => p.paymentType === 'advance')?.paymentMethod || (isDelivered ? 'delivery' : null),
      };

      let installmentLedger = [];
      let paidInstallments = 0;
      let pendingInstallments = totalMonths;

      if (isDelivered && deliveryDate && totalMonths > 0) {
        let current = new Date(deliveryDate);
        current.setMonth(current.getMonth() + 1);
        current.setDate(5); // Qist Market standard due day

        for (let i = 0; i < totalMonths; i++) {
          const mNum = i + 1;
          const dueDate = new Date(current);
          const payment = dbPayments.find(p => p.paymentType === 'installment' && p.monthNumber === mNum);

          if (payment) {
            paidInstallments++;
            pendingInstallments--;
          }

          installmentLedger.push({
            monthNumber: mNum,
            dueDate: dueDate.toISOString().split('T')[0],
            yearMonth: dueDate.toISOString().slice(0, 7),
            dueAmount: monthlyAmount,
            paidAmount: payment ? payment.amount : 0,
            remainingAmount: payment ? 0 : monthlyAmount,
            status: payment ? 'paid' : (new Date() > dueDate ? 'overdue' : 'pending'),
            paidAt: payment ? payment.paidAt : null,
          });

          // Move to next month
          current.setMonth(current.getMonth() + 1);
        }
      }

      const totalPaid = dbPayments.reduce((sum, p) => sum + p.amount, 0);
      const totalDue = advanceAmount + (monthlyAmount * totalMonths);
      const totalRemaining = Math.max(0, totalDue - totalPaid);

      const orderEntry = {
        order_id: order.id,
        order_ref: order.order_ref,
        token_number: order.token_number,
        product_name: order.product_name,
        total_amount: order.total_amount,
        advance_amount: advanceAmount,
        monthly_amount: monthlyAmount,
        months: totalMonths,
        status: order.status,
        created_at: order.created_at.toISOString(),
        is_delivered: isDelivered,
        delivered_at: deliveryDate ? deliveryDate.toISOString() : null,
        verification_status: order.verification?.status || null,

        ledgerHistory: {
          advancePayment,
          installmentLedger,
          summary: {
            totalDue,
            totalPaid,
            totalRemaining,
            paidInstallments,
            pendingInstallments,
            installmentsStarted: isDelivered && totalMonths > 0,
            firstInstallmentDate: installmentLedger[0]?.dueDate || null,
          },
        },
      };

      group.orders.push(orderEntry);

      group.ledgerSummary.totalOrders += 1;
      group.ledgerSummary.totalAdvanceReceived += advanceAmount;

      if (isDelivered) {
        group.ledgerSummary.paidOrders += 1;
      } else {
        group.ledgerSummary.pendingOrders += 1;
        group.ledgerSummary.totalPendingAmount += totalRemaining;
      }
    }

    const customers = Array.from(customerMap.values())
      .sort((a, b) => a.customer.name.localeCompare(b.customer.name));

    return res.status(200).json({
      success: true,
      data: {
        month: startOfMonth.toISOString().slice(0, 7),
        totalCustomers: customers.length,
        totalOrders: orders.length,
        paidOrders: orders.filter(o => o.is_delivered || o.delivery?.status === 'completed').length,
        pendingOrders: orders.length - orders.filter(o => o.is_delivered || o.delivery?.status === 'completed').length,
        customers,
      },
    });
  } catch (error) {
    console.error('Error in getMyCustomersWithOrdersAndLedger:', error);
    return res.status(500).json({ success: false, error: { code: 500, message: 'Internal server error' } });
  }
};

module.exports = {
  getVerifications,
  startVerification,
  savePurchaserVerification,
  saveGrantorVerification,
  saveNextOfKin,
  saveLocation,
  saveVerificationLocation,
  getVerificationLocations,
  deleteVerificationLocation,
  uploadPurchaserDocument,
  uploadGrantorDocument,
  uploadPhoto,
  uploadSignature,
  deleteDocument,
  completeVerification,
  getVerificationByOrderId,
  submitVerificationReview,
  getMyPendingOrders: getMyAssignedOrdersCursorPaginated('pending'),
  getMyConfirmedOrders: getMyAssignedOrdersCursorPaginated('confirmed'),
  getMyCancelledOrders: getMyAssignedOrdersCursorPaginated('cancelled'),
  getMyCustomersWithOrdersAndLedger,
};