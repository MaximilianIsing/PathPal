const express = require('express');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Read GPT key from environment variable (for Render) or file (for local dev)
let GPT_API_KEY = process.env.GPT_API_KEY || '';
if (!GPT_API_KEY) {
  try {
    GPT_API_KEY = fs.readFileSync(path.join(__dirname, 'gpt-key.txt'), 'utf8').trim();
  } catch (error) {
    console.error('Warning: GPT API key not found in environment or file');
  }
}

// API endpoint for GPT requests
app.post('/api/chat', async (req, res) => {
  try {
    const { message, context } = req.body;
    
    if (!GPT_API_KEY) {
      return res.status(500).json({ error: 'GPT API key not configured' });
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GPT_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content: 'You are a helpful college admissions counselor and academic advisor. Provide personalized, actionable advice for students planning their college path.'
          },
          ...(context || []),
          {
            role: 'user',
            content: message
          }
        ],
        temperature: 0.7,
        max_tokens: 1000
      })
    });

    const data = await response.json();
    
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'API error' });
    }

    res.json({ 
      message: data.choices[0].message.content,
      usage: data.usage
    });
  } catch (error) {
    console.error('GPT API error:', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// Serve all HTML pages
const htmlPages = [
  'index.html', 'profile.html', 'odds.html', 'simulator.html', 
  'explorer.html', 'career.html', 'activities.html', 'planner.html', 
  'messages.html', 'saved.html'
];

htmlPages.forEach(page => {
  app.get(`/${page}`, (req, res) => {
    res.sendFile(path.join(__dirname, 'pages', page));
  });
  
  // Also handle without .html extension
  const route = page.replace('.html', '');
  if (route !== 'index') {
    app.get(`/${route}`, (req, res) => {
      res.sendFile(path.join(__dirname, 'pages', page));
    });
  }
});

// Serve index.html for root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages', 'index.html'));
});

// College Scorecard API endpoint
const COLLEGE_SCORECARD_API_KEY = process.env.COLLEGE_SCORECARD_API_KEY || '';

app.get('/api/colleges', async (req, res) => {
  try {
    const { search, page = 1, per_page = 20 } = req.query;
    
    if (!COLLEGE_SCORECARD_API_KEY) {
      // Return mock data if API key not configured
      return res.json({
        results: [],
        page: 1,
        per_page: 20,
        total: 0,
        note: 'College Scorecard API key not configured. Using mock data.'
      });
    }

    let url = `https://api.data.gov/ed/collegescorecard/v1/schools.json?api_key=${COLLEGE_SCORECARD_API_KEY}&page=${page}&per_page=${per_page}&fields=id,school.name,school.city,school.state,school.ownership,latest.admissions.admission_rate.overall,latest.cost.tuition.in_state,latest.cost.tuition.out_of_state,latest.school.size,latest.admissions.sat_scores.average.overall,latest.admissions.act_scores.midpoint.cumulative,latest.school.locale`;
    
    if (search) {
      url += `&school.name=${encodeURIComponent(search)}`;
    }

    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`College Scorecard API error: ${response.status}`);
    }

    const data = await response.json();
    
    // Transform data to match your format
    const transformed = data.results.map(school => ({
      id: school.id,
      name: school['school.name'] || 'Unknown',
      location: `${school['school.city'] || ''}, ${school['school.state'] || ''}`.trim(),
      state: school['school.state'] || '',
      city: school['school.city'] || '',
      size: getSizeCategory(school['latest.school.size']),
      type: getTypeFromOwnership(school['school.ownership']),
      acceptanceRate: school['latest.admissions.admission_rate.overall'] || null,
      tuitionInState: school['latest.cost.tuition.in_state'] || null,
      tuitionOutState: school['latest.cost.tuition.out_of_state'] || null,
      satAverage: school['latest.admissions.sat_scores.average.overall'] || null,
      actMidpoint: school['latest.admissions.act_scores.midpoint.cumulative'] || null,
      locale: school['latest.school.locale'] || null
    }));

    res.json({
      results: transformed,
      page: parseInt(page),
      per_page: parseInt(per_page),
      total: data.metadata?.total || transformed.length
    });
  } catch (error) {
    console.error('College Scorecard API error:', error);
    res.status(500).json({ error: 'Failed to fetch college data' });
  }
});

// Helper functions
function getSizeCategory(enrollment) {
  if (!enrollment) return 'Unknown';
  if (enrollment < 5000) return 'Small';
  if (enrollment < 15000) return 'Medium';
  return 'Large';
}

function getTypeFromOwnership(ownership) {
  const types = {
    1: 'Public',
    2: 'Private',
    3: 'Private For-Profit'
  };
  return types[ownership] || 'Unknown';
}

// Health check endpoint for Render
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Path Pal server running on port ${PORT}`);
  if (GPT_API_KEY) {
    console.log('✓ GPT API key configured');
  } else {
    console.warn('⚠ Warning: GPT API key not configured. AI features will not work.');
  }
  if (COLLEGE_SCORECARD_API_KEY) {
    console.log('✓ College Scorecard API key configured');
  } else {
    console.warn('⚠ Warning: College Scorecard API key not configured. Real college data not available.');
    console.warn('  Get your free API key at: https://api.data.gov/signup/');
  }
});

