require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let savedLeads = [];

// ── Search Route ──────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { industry, location } = req.query;
  if (!industry || !location) return res.status(400).json({ error: 'Industry and location are required' });

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey || apiKey === 'your_google_places_api_key_here') {
    return res.status(500).json({ error: 'Google API key not configured.' });
  }

  try {
    const searchRes = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
      params: { query: `${industry} in ${location}`, key: apiKey }
    });

    const data = searchRes.data;
    if (data.status === 'REQUEST_DENIED') return res.status(403).json({ error: 'API key rejected: ' + (data.error_message || 'Check key and billing') });
    if (data.status === 'ZERO_RESULTS' || !data.results) return res.json({ results: [] });

    // Get details for each place (includes phone, hours etc)
    const detailed = await Promise.all(
      data.results.slice(0, 15).map(p => fetchDetails(p, industry, apiKey))
    );

    detailed.sort((a, b) => ({ hot: 0, warm: 1, cold: 2 }[a.leadScore] - { hot: 0, warm: 1, cold: 2 }[b.leadScore]));
    res.json({ results: detailed });

  } catch (err) {
    res.status(500).json({ error: 'Search failed: ' + err.message });
  }
});

async function fetchDetails(place, industry, apiKey) {
  try {
    const r = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
      params: {
        place_id: place.place_id,
        fields: 'name,formatted_address,rating,user_ratings_total,website,formatted_phone_number,url',
        key: apiKey
      }
    });
    const d = r.data.result || {};
    const social = buildSocialLinks(place.name);
    return scorePlace({ ...place, website: d.website || place.website, formatted_phone_number: d.formatted_phone_number, googleMapsUrl: d.url }, industry, social);
  } catch {
    return scorePlace(place, industry, buildSocialLinks(place.name));
  }
}

function buildSocialLinks(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return {
    facebookSearch: `https://www.facebook.com/search/pages/?q=${encodeURIComponent(name)}`,
    facebookGuess: `https://www.facebook.com/${slug}`,
    instagramSearch: `https://www.instagram.com/${slug}`,
  };
}

function scorePlace(place, industry, socialLinks) {
  const hasWebsite = !!place.website;
  const rating = place.rating || 0;
  const reviews = place.user_ratings_total || 0;
  let score = 0, signals = [];

  if (!hasWebsite) { score += 3; signals.push({ text: 'No website', type: 'bad' }); }
  else { score += 1; signals.push({ text: 'Has website', type: 'good' }); }

  if (rating >= 4.0) { score += 2; signals.push({ text: `⭐ ${rating} stars`, type: 'good' }); }
  else if (rating > 0) signals.push({ text: `⭐ ${rating} stars`, type: 'neutral' });

  if (reviews >= 20) { score += 1; signals.push({ text: `${reviews} reviews`, type: 'good' }); }
  else if (reviews > 0) signals.push({ text: `${reviews} reviews`, type: 'neutral' });

  signals.push({ text: 'No chatbot detected', type: 'bad' });
  score += 2;

  return {
    name: place.name,
    address: place.formatted_address || place.vicinity || '',
    phone: place.formatted_phone_number || null,
    rating, reviews, hasWebsite,
    website: place.website || null,
    placeId: place.place_id,
    googleMapsUrl: place.googleMapsUrl || `https://www.google.com/maps/place/?q=place_id:${place.place_id}`,
    socialLinks,
    signals,
    leadScore: score >= 7 ? 'hot' : score >= 5 ? 'warm' : 'cold',
    industry
  };
}

// ── Leads CRUD ────────────────────────────────────────────────
app.get('/api/leads', (req, res) => res.json(savedLeads));
app.post('/api/leads', (req, res) => {
  const lead = { ...req.body, id: Date.now(), savedAt: new Date().toISOString(), status: 'new' };
  savedLeads.push(lead);
  res.json(lead);
});
app.patch('/api/leads/:id', (req, res) => {
  const idx = savedLeads.findIndex(l => l.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  savedLeads[idx] = { ...savedLeads[idx], ...req.body };
  res.json(savedLeads[idx]);
});
app.delete('/api/leads/:id', (req, res) => {
  savedLeads = savedLeads.filter(l => l.id !== parseInt(req.params.id));
  res.json({ success: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`✅ Lead Finder running at http://localhost:${PORT}`));
