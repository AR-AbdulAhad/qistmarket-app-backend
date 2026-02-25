const axios = require('axios');

const getProducts = async (req, res) => {
    try {
        const response = await axios.get('https://api.qistmarket.pk/api/product');

        // The API returns an array of products
        const products = response.data;

        res.status(200).json({
            success: true,
            data: products
        });
    } catch (error) {
        console.error('Error fetching external products:', error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch products from external API'
        });
    }
};

module.exports = {
    getProducts
};
