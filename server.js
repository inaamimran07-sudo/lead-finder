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

// Surrounding areas for major UK cities
const nearbyAreas = {
  manchester: ['Manchester', 'Salford', 'Stockport', 'Oldham', 'Bolton', 'Bury'],
  london: ['London', 'Croydon', 'Bromley', 'Ealing', 'Barnet', 'Hackney'],
  birmingham: ['Birmingham', 'Wolverhampton', 'Solihull', 'Dudley', 'Walsall', 'Coventry'],
  leeds: ['Leeds', 'Bradford', 'Wakefield', 'Huddersfield', 'Halifax', 'Harrogate'],
  liverpool: ['Liverpool', 'Wirral', 'Warrington', 'St Helens', 'Birkenhead', 'Bootle'],
  sheffield: ['Sheffield', 'Rotherham', 'Doncaster', 'Barnsley', 'Chesterfield'],
  bristol: ['Bristol', 'Bath', 'Weston-super-Mare', 'Gloucester', 'Cheltenham'],
  default: (city) => [city]
};

function getSearchAreas(location) {
  const key = location.toLowerCase().trim();
  for (const [city, areas] of Object.entries(nearbyAreas)) {
    if (city === 'default') continue;
    if (key.includes(city)) return areas;
  }
  return [location]; // single area for unknown cities
}

// ── Search Route ──────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { industry, location } = req.query;
  if (!industry || !location) return res.status(400).json({ error: 'Industry and location are required' });

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey || apiKey === 'your_google_places_api_key_here') {
    return res.status(500).json({ error: 'Google API key not configured.' });
  }

  try {
    const areas = getSearchAreas(location);
    console.log(`Searching ${areas.length} areas for ${industry}:`, areas);

    // Search all areas in parallel
    const allPlaces = [];
    const seenIds = new Set();

    await Promise.all(areas.map(async (area) => {
      try {
        const searchRes = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
          params: { query: `${industry} in ${area}`, key: apiKey }
        });

        if (searchRes.data.results) {
          for (const place of searchRes.data.results) {
            if (!seenIds.has(place.place_id)) {
              seenIds.add(place.place_id);
              allPlaces.push(place);
            }
          }
        }

        // Get next page if available (up to 2 pages per area)
        if (searchRes.data.next_page_token) {
          await new Promise(r => setTimeout(r, 2000)); // Google requires delay
          const page2 = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
            params: { pagetoken: searchRes.data.next_page_token, key: apiKey }
          });
          if (page2.data.results) {
            for (const place of page2.data.results) {
              if (!seenIds.has(place.place_id)) {
                seenIds.add(place.place_id);
                allPlaces.push(place);
              }
            }
          }
        }
      } catch (e) {
        console.log(`Failed for area ${area}:`, e.message);
      }
    }));

    if (allPlaces.length === 0) return res.json({ results: [] });

    // Get details for each place
    const detailed = await Promise.all(
      allPlaces.slice(0, 60).map(p => fetchDetails(p, industry, apiKey))
    );

    // Sort: hot first, then warm, then cold. Within same score, no-website first
    detailed.sort((a, b) => {
      const scoreOrder = { hot: 0, warm: 1, cold: 2 };
      if (scoreOrder[a.leadScore] !== scoreOrder[b.leadScore]) {
        return scoreOrder[a.leadScore] - scoreOrder[b.leadScore];
      }
      // Both same score — no website comes first
      if (!a.hasWebsite && b.hasWebsite) return -1;
      if (a.hasWebsite && !b.hasWebsite) return 1;
      // Then higher reviews
      return (b.reviews || 0) - (a.reviews || 0);
    });

    res.json({ results: detailed, areasSearched: areas });

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
    const website = d.website || place.website || null;
    const social = buildSocialLinks(place.name, website);
    return scorePlace({
      ...place,
      website,
      formatted_phone_number: d.formatted_phone_number,
      googleMapsUrl: d.url
    }, industry, social);
  } catch {
    return scorePlace(place, industry, buildSocialLinks(place.name, null));
  }
}

function buildSocialLinks(name, website) {
  // Clean name for URL slug guessing
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const slugDash = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

  // Extract domain from website if available
  let domain = null;
  if (website) {
    try { domain = new URL(website).hostname.replace('www.', ''); } catch {}
  }

  return {
    // Facebook search is the most reliable — searches for their business page by name
    facebookSearch: `https://www.facebook.com/search/pages/?q=${encodeURIComponent(name)}`,
    // Instagram search via Google (most reliable way)
    instagramSearch: `https://www.google.com/search?q=${encodeURIComponent(name + ' instagram')}`,
    // Direct guesses (may or may not exist)
    facebookGuess: `https://www.facebook.com/${slug}`,
    instagramGuess: `https://www.instagram.com/${slug}`,
    domain
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
