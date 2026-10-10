const express = require('express');
const router = express.Router();
const { buildMorningDigest, sendMorningDigest, getDigestSettings, saveDigestSettings } = require('../digest');

// Утренний дайджест: настройки, предпросмотр, отправка сейчас.
router.get('/settings', async (req, res) => {
  try { res.json({ success: true, data: await getDigestSettings(req.query.cabinet || 'defly') }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.post('/settings', async (req, res) => {
  try {
    const { cabinet = 'defly', enabled, time, tax } = req.body || {};
    const s = {};
    if (enabled !== undefined) s.enabled = !!enabled;
    if (time && /^\d{1,2}:\d{2}$/.test(time)) s.time = time;
    if (tax !== undefined && Number.isFinite(Number(tax))) s.tax = Number(tax);
    res.json({ success: true, data: await saveDigestSettings(cabinet, s) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.get('/preview', async (req, res) => {
  try { res.json({ success: true, data: { text: await buildMorningDigest(req.query.cabinet || 'defly') } }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
router.post('/send', async (req, res) => {
  try { res.json({ success: true, data: { sent: await sendMorningDigest(req.query.cabinet || req.body?.cabinet || 'defly') } }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
module.exports = router;
