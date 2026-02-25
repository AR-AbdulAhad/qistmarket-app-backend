const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// City Operations
const getCities = async (req, res) => {
    try {
        const cities = await prisma.city.findMany({
            include: { _count: { select: { zones: true } } },
            orderBy: { name: 'asc' }
        });
        return res.json({ success: true, data: cities });
    } catch (error) {
        console.error('getCities error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

const createCity = async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Name is required' });
    try {
        const city = await prisma.city.create({ data: { name } });
        return res.json({ success: true, data: city });
    } catch (error) {
        console.error('createCity error:', error);
        if (error.code === 'P2002') return res.status(400).json({ success: false, error: 'City already exists' });
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

const updateCity = async (req, res) => {
    const { id } = req.params;
    const { name } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Name is required' });
    try {
        const city = await prisma.city.update({
            where: { id: parseInt(id) },
            data: { name }
        });
        return res.json({ success: true, data: city });
    } catch (error) {
        console.error('updateCity error:', error);
        if (error.code === 'P2002') return res.status(400).json({ success: false, error: 'City name already exists' });
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

// Zone Operations
const getZones = async (req, res) => {
    const { cityId } = req.query;
    try {
        const where = cityId ? { city_id: parseInt(cityId) } : {};
        const zones = await prisma.zone.findMany({
            where,
            include: { city: true, _count: { select: { areas: true } } },
            orderBy: { name: 'asc' }
        });
        return res.json({ success: true, data: zones });
    } catch (error) {
        console.error('getZones error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

const createZone = async (req, res) => {
    const { name, city_id } = req.body;
    if (!name || !city_id) return res.status(400).json({ success: false, error: 'Name and city_id are required' });
    try {
        const zone = await prisma.zone.create({ data: { name, city_id: parseInt(city_id) } });
        return res.json({ success: true, data: zone });
    } catch (error) {
        console.error('createZone error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

const updateZone = async (req, res) => {
    const { id } = req.params;
    const { name, city_id } = req.body;
    if (!name || !city_id) return res.status(400).json({ success: false, error: 'Name and city_id are required' });
    try {
        const zone = await prisma.zone.update({
            where: { id: parseInt(id) },
            data: { name, city_id: parseInt(city_id) }
        });
        return res.json({ success: true, data: zone });
    } catch (error) {
        console.error('updateZone error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

// Area Operations
const getAreas = async (req, res) => {
    const { zoneId } = req.query;
    try {
        const where = zoneId ? { zone_id: parseInt(zoneId) } : {};
        const areas = await prisma.area.findMany({
            where,
            include: { zone: { include: { city: true } } },
            orderBy: { name: 'asc' }
        });
        return res.json({ success: true, data: areas });
    } catch (error) {
        console.error('getAreas error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

const createArea = async (req, res) => {
    const { name, zone_id } = req.body;
    if (!name || !zone_id) return res.status(400).json({ success: false, error: 'Name and zone_id are required' });
    try {
        const area = await prisma.area.create({ data: { name, zone_id: parseInt(zone_id) } });
        return res.json({ success: true, data: area });
    } catch (error) {
        console.error('createArea error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

const updateArea = async (req, res) => {
    const { id } = req.params;
    const { name, zone_id } = req.body;
    if (!name || !zone_id) return res.status(400).json({ success: false, error: 'Name and zone_id are required' });
    try {
        const area = await prisma.area.update({
            where: { id: parseInt(id) },
            data: { name, zone_id: parseInt(zone_id) }
        });
        return res.json({ success: true, data: area });
    } catch (error) {
        console.error('updateArea error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

// Hierarchical Fetch
const getAddressHierarchy = async (req, res) => {
    try {
        const hierarchy = await prisma.city.findMany({
            include: {
                zones: {
                    include: {
                        areas: true
                    }
                }
            },
            orderBy: { name: 'asc' }
        });
        return res.json({ success: true, data: hierarchy });
    } catch (error) {
        console.error('getAddressHierarchy error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

// Delete Operations (Optional but helpful)
const deleteCity = async (req, res) => {
    const { id } = req.params;
    try {
        await prisma.city.delete({ where: { id: parseInt(id) } });
        return res.json({ success: true, message: 'City deleted' });
    } catch (error) {
        console.error('deleteCity error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

const deleteZone = async (req, res) => {
    const { id } = req.params;
    try {
        await prisma.zone.delete({ where: { id: parseInt(id) } });
        return res.json({ success: true, message: 'Zone deleted' });
    } catch (error) {
        console.error('deleteZone error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

const deleteArea = async (req, res) => {
    const { id } = req.params;
    try {
        await prisma.area.delete({ where: { id: parseInt(id) } });
        return res.json({ success: true, message: 'Area deleted' });
    } catch (error) {
        console.error('deleteArea error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

const bulkUploadAddresses = async (req, res) => {
    const { data } = req.body; // Expecting array of { city, zone, area }
    if (!data || !Array.isArray(data)) return res.status(400).json({ success: false, error: 'Invalid data format' });

    try {
        let createdCount = 0;
        for (const row of data) {
            const { city: cityName, zone: zoneName, area: areaName } = row;
            if (!cityName || !zoneName || !areaName) continue;

            // 1. Find or create city
            let city = await prisma.city.findUnique({ where: { name: cityName.trim() } });
            if (!city) {
                city = await prisma.city.create({ data: { name: cityName.trim() } });
            }

            // 2. Find or create zone
            let zone = await prisma.zone.findFirst({
                where: { name: zoneName.trim(), city_id: city.id }
            });
            if (!zone) {
                zone = await prisma.zone.create({
                    data: { name: zoneName.trim(), city_id: city.id }
                });
            }

            // 3. Find or create area
            let area = await prisma.area.findFirst({
                where: { name: areaName.trim(), zone_id: zone.id }
            });
            if (!area) {
                await prisma.area.create({
                    data: { name: areaName.trim(), zone_id: zone.id }
                });
                createdCount++;
            }
        }
        return res.json({ success: true, message: `Successfully processed. New areas created: ${createdCount}` });
    } catch (error) {
        console.error('bulkUploadAddresses error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

module.exports = {
    getCities,
    createCity,
    updateCity,
    deleteCity,
    getZones,
    createZone,
    updateZone,
    deleteZone,
    getAreas,
    createArea,
    updateArea,
    deleteArea,
    getAddressHierarchy,
    bulkUploadAddresses
};
