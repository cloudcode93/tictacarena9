const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const cache = require('../utils/cache');

// Get topup packages (cached 5 min — these rarely change)
router.get('/', async (req, res) => {
  try {
    const packages = await cache.getOrSet('topup_packages', 300, async () => {
      const { data, error } = await supabase
        .from('topup_packages')
        .select('*')
        .eq('active', true)
        .order('sort_order');
      if (error) throw error;
      return data || [];
    });
    res.json(packages);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
