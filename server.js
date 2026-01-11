const express = require('express');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { rateStudent, getAdmissionOdds } = require('./rate-system');
const { fetchCollegeData, checkApiHealth } = require('./get-data');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increase limit for transcript images
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting for AI features (non-obstructive, just to prevent spam)
const rateLimitStore = new Map(); // userId -> { count: number, resetTime: number }
const RATE_LIMIT_REQUESTS = 20; // Number of requests allowed
const RATE_LIMIT_WINDOW = 60 * 1000; // Time window in milliseconds (1 minute)

function checkRateLimit(userId) {
  const now = Date.now();
  const userLimit = rateLimitStore.get(userId);
  
  // If no record exists or the window has expired, create/reset
  if (!userLimit || now > userLimit.resetTime) {
    rateLimitStore.set(userId, {
      count: 1,
      resetTime: now + RATE_LIMIT_WINDOW
    });
    return { allowed: true, remaining: RATE_LIMIT_REQUESTS - 1 };
  }
  
  // If under the limit, increment and allow
  if (userLimit.count < RATE_LIMIT_REQUESTS) {
    userLimit.count++;
    return { allowed: true, remaining: RATE_LIMIT_REQUESTS - userLimit.count };
  }
  
  // Over the limit
  const timeUntilReset = Math.ceil((userLimit.resetTime - now) / 1000);
  return { 
    allowed: false, 
    remaining: 0,
    resetIn: timeUntilReset
  };
}

// Clean up old entries periodically (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [userId, limit] of rateLimitStore.entries()) {
    if (now > limit.resetTime) {
      rateLimitStore.delete(userId);
    }
  }
}, 5 * 60 * 1000);

// Read PC mode setting from file or environment variable
let SERVE_PC_MODE = false;
function updatePCMode() {
  try {
    const pcModeFile = fs.readFileSync(path.join(__dirname, 'serve-pc.txt'), 'utf8').trim().toLowerCase();
    SERVE_PC_MODE = pcModeFile === 'true';
  } catch (error) {
    // If file doesn't exist or can't be read, use environment variable or default to false
    SERVE_PC_MODE = (process.env.SERVE_PC_MODE || 'false').toLowerCase() === 'true';
  }
}
updatePCMode(); // Initial load

// Watch for changes to serve-pc.txt file
try {
  fs.watchFile(path.join(__dirname, 'serve-pc.txt'), { interval: 1000 }, () => {
    updatePCMode();
    console.log(`PC mode updated: ${SERVE_PC_MODE}`);
  });
} catch (error) {
  console.log('Could not watch serve-pc.txt file (file may not exist yet)');
}

// API endpoint to check PC mode
app.get('/api/pc-mode', (req, res) => {
  res.json({ pcMode: SERVE_PC_MODE });
});

// API endpoint to get blog posts
app.get('/api/blog-posts', (req, res) => {
  try {
    const blogPostsPath = path.join(__dirname, 'public', 'media', 'blogs', 'blogposts.json');
    if (!fs.existsSync(blogPostsPath)) {
      return res.json([]);
    }

    const jsonText = fs.readFileSync(blogPostsPath, 'utf8');
    const blogPosts = JSON.parse(jsonText);

    res.json(blogPosts);
  } catch (error) {
    console.error('Error reading blog posts JSON:', error);
    res.status(500).json({ error: 'Failed to load blog posts' });
  }
});

// Read GPT key from environment variable (for Render) or file (for local dev)
let GPT_API_KEY = process.env.GPT_API_KEY || '';
if (!GPT_API_KEY) {
  try {
    GPT_API_KEY = fs.readFileSync(path.join(__dirname, 'gpt-key.txt'), 'utf8').trim();
  } catch (error) {
    console.error('Warning: GPT API key not found in environment or file');
  }
}

// Read Email API key from environment variable (for Render) or file (for local dev)
let EMAIL_API_KEY = process.env.EMAIL_API_KEY || '';
let EMAIL_SERVICE = process.env.EMAIL_SERVICE || 'resend'; // 'resend', 'sendgrid', or 'mailgun'
if (!EMAIL_API_KEY) {
  try {
    EMAIL_API_KEY = fs.readFileSync(path.join(__dirname, 'email-key.txt'), 'utf8').trim();
  } catch (error) {
    console.log('Email API key not found - email functionality will be disabled');
  }
}

// Read News API key from environment variable (for Render) or file (for local dev)
let NEWS_API_KEY = process.env.NEWS_API_KEY || '';
if (!NEWS_API_KEY) {
  try {
    NEWS_API_KEY = fs.readFileSync(path.join(__dirname, 'news-key.txt'), 'utf8').trim();
  } catch (error) {
    console.log('News API key not found - news functionality will be disabled');
  }
}

// Configure email transporter
let emailTransporter = null;
if (EMAIL_API_KEY) {
  // Configure based on service
  const smtpConfig = {
    resend: {
      host: 'smtp.resend.com',
      port: 587,
      secure: false,
      auth: {
        user: 'resend',
        pass: EMAIL_API_KEY
      }
    },
    sendgrid: {
      host: 'smtp.sendgrid.net',
      port: 587,
      secure: false,
      auth: {
        user: 'apikey',
        pass: EMAIL_API_KEY
      }
    },
    mailgun: {
      host: 'smtp.mailgun.org',
      port: 587,
      secure: false,
      auth: {
        user: 'postmaster@your-domain.mailgun.org', // Update with your Mailgun domain
        pass: EMAIL_API_KEY
      }
    }
  };

  const config = smtpConfig[EMAIL_SERVICE] || smtpConfig.resend;
  emailTransporter = nodemailer.createTransport(config);
  
  // Verify connection
  emailTransporter.verify((error, success) => {
    if (error) {
      console.error('Email transporter verification failed:', error);
    } else {
      console.log('✓ Email transporter ready');
    }
  });
}

/**
 * Send an email
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject
 * @param {string} html - HTML email content
 * @param {string} text - Plain text email content (optional)
 * @returns {Promise<boolean>} - Success status
 */
async function sendEmail(to, subject, html, text = null) {
  if (!emailTransporter) {
    console.error('Email transporter not configured');
    return false;
  }

  try {
    const info = await emailTransporter.sendMail({
      from: 'Team@pathpal.us',
      to: to,
      subject: subject,
      html: html,
      text: text || html.replace(/<[^>]*>/g, '') // Strip HTML for text version
    });

    console.log('Email sent:', info.messageId);
    return true;
  } catch (error) {
    console.error('Error sending email:', error);
    return false;
  }
}

// API endpoint for GPT requests
app.post('/api/chat', async (req, res) => {
  try {
    const { message, context, responseLength = 'medium', images = [] } = req.body;
    const userId = req.headers['user-id'] || 'anonymous';
    const timestamp = new Date().toISOString();
    
    // Check rate limit
    const rateLimit = checkRateLimit(userId);
    if (!rateLimit.allowed) {
      return res.status(429).json({ 
        error: `Rate limit exceeded. Please wait ${rateLimit.resetIn} seconds before making another request.`,
        rateLimit: {
          resetIn: rateLimit.resetIn
        }
      });
    }
    
    // Log incoming message from user
    try {
      const logEntry = `${escapeCSV(timestamp)},${escapeCSV(userId)},received,${escapeCSV(message)}\n`;
      fs.appendFileSync(COUNSELOR_CSV_PATH, logEntry, 'utf8');
    } catch (logError) {
      console.error('Error logging incoming message:', logError);
    }
    
    if (!GPT_API_KEY) {
      return res.status(500).json({ error: 'GPT API key not configured' });
    }

    // Map response length to max_tokens
    const maxTokensMap = {
      'short': 200,   // Brief, 1-2 sentences
      'medium': 500,  // Moderate, 2-4 sentences
      'long': 1000    // Detailed, 4+ sentences
    };
    const maxTokens = maxTokensMap[responseLength] || maxTokensMap['medium'];

    // Build user message content - include images if present
    let userContent = message;
    if (images && images.length > 0) {
      // For vision API, use content array format
      userContent = [
        { type: 'text', text: message || 'Please analyze these images.' }
      ];
      images.forEach(img => {
        userContent.push({
          type: 'image_url',
          image_url: {
            url: img.data // base64 data URL
          }
        });
      });
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GPT_API_KEY}`
      },
      body: JSON.stringify({
        model: images && images.length > 0 ? 'gpt-4o' : 'gpt-4',
        messages: [
          {
            role: 'system',
            content: 'You are a helpful college admissions counselor and academic advisor. Provide personalized, actionable advice for students planning their college path.'
          },
          ...(context || []),
          {
            role: 'user',
            content: userContent
          }
        ],
        temperature: 0.7,
        max_tokens: maxTokens
      })
    });

    const data = await response.json();
    
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'API error' });
    }

    const aiMessage = data.choices[0].message.content;
    
    // Log outgoing message from AI
    try {
      const logEntry = `${escapeCSV(timestamp)},${escapeCSV(userId)},sent,${escapeCSV(aiMessage)}\n`;
      fs.appendFileSync(COUNSELOR_CSV_PATH, logEntry, 'utf8');
    } catch (logError) {
      console.error('Error logging outgoing message:', logError);
    }

    res.json({ 
      message: aiMessage,
      usage: data.usage
    });
  } catch (error) {
    console.error('GPT API error:', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// Read transcript uploads from CSV
function readTranscriptUploads() {
  try {
    if (!fs.existsSync(TRANSCRIPT_UPLOADS_CSV_PATH)) {
      return [];
    }

    const csvText = fs.readFileSync(TRANSCRIPT_UPLOADS_CSV_PATH, 'utf8');
    const lines = csvText.split('\n').filter(line => line.trim());
    
    if (lines.length < 2) {
      return [];
    }

    const headers = parseCSVLine(lines[0]);
    const uploads = [];
    
    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
      if (values.length === headers.length) {
        const upload = {};
        headers.forEach((header, index) => {
          upload[header] = values[index] || '';
        });
        uploads.push(upload);
      }
    }
    
    return uploads;
  } catch (error) {
    console.error('Error reading transcript uploads CSV:', error);
    return [];
  }
}

// Write transcript uploads to CSV
function writeTranscriptUploads(uploads) {
  try {
    const headers = ['user_id', 'date', 'timestamp'];
    let csv = headers.join(',') + '\n';
    
    uploads.forEach(upload => {
      const row = headers.map(header => {
        let value = upload[header] || '';
        if (typeof value === 'string' && (value.includes(',') || value.includes('\n') || value.includes('"'))) {
          value = '"' + value.replace(/"/g, '""') + '"';
        }
        return value;
      });
      csv += row.join(',') + '\n';
    });
    
    fs.writeFileSync(TRANSCRIPT_UPLOADS_CSV_PATH, csv, 'utf8');
    return true;
  } catch (error) {
    console.error('Error writing transcript uploads CSV:', error);
    return false;
  }
}

// Check if user has exceeded daily upload limit
function checkUploadLimit(userId) {
  const uploads = readTranscriptUploads();
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
  
  // Count uploads for this user today
  const todayUploads = uploads.filter(upload => 
    upload.user_id === userId && upload.date === today
  );
  
  return todayUploads.length >= 3; // Limit is 3 per day
}

// Record transcript upload
function recordTranscriptUpload(userId) {
  const uploads = readTranscriptUploads();
  const now = new Date();
  const date = now.toISOString().split('T')[0]; // YYYY-MM-DD format
  const timestamp = now.toISOString();
  
  uploads.push({
    user_id: userId,
    date: date,
    timestamp: timestamp
  });
  
  writeTranscriptUploads(uploads);
}

// API endpoint for transcript processing with GPT Vision
app.post('/api/transcript/process', async (req, res) => {
  try {
    const { image_base64 } = req.body;
    const userId = req.headers['user-id'] || 'anonymous';
    
    if (!GPT_API_KEY) {
      return res.status(500).json({ error: 'GPT API key not configured' });
    }

    if (!image_base64) {
      return res.status(400).json({ error: 'Image is required' });
    }

    // Check upload limit (3 per day per user)
    if (checkUploadLimit(userId)) {
      return res.status(429).json({ 
        error: 'Daily upload limit reached. You can upload up to 3 transcripts per day. Please try again tomorrow or enter courses manually.' 
      });
    }

    // Remove data URL prefix if present
    const base64Image = image_base64.replace(/^data:image\/[a-z]+;base64,/, '');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GPT_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o', // Using GPT-4o for vision capabilities
        messages: [
          {
            role: 'system',
            content: 'You are an expert at extracting academic course information from transcripts. Extract all courses with their names, grades (letter grades like A, B+, C-, etc.), and course types (Regular, Honors, AP, or College). Return ONLY a valid JSON array of objects, each with: courseName (string), grade (string like "A", "B+", "C-", etc.), and courseType (one of: "Regular", "Honors", "AP", "College"). Do not include any other text, just the JSON array.'
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Extract all academic courses from this transcript. For each course, provide the course name, letter grade (A+, A, A-, B+, B, B-, C+, C, C-, D+, D, D-, F), and course type (Regular, Honors, AP, or College). Return only a JSON array in this exact format: [{"courseName": "English 9", "grade": "A", "courseType": "Regular"}, {"courseName": "AP Calculus", "grade": "B+", "courseType": "AP"}]'
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`
                }
              }
            ]
          }
        ],
        temperature: 0.1,
        max_tokens: 2000
      })
    });

    const data = await response.json();
    
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'API error' });
    }

    const content = data.choices[0].message.content;
    
    // Try to extract JSON from the response
    let courses = [];
    try {
      // Remove any markdown code blocks if present
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        courses = JSON.parse(jsonMatch[0]);
      } else {
        courses = JSON.parse(content);
      }
      
      // Validate and clean the courses
      courses = courses.filter(course => {
        return course.courseName && course.grade && course.courseType;
      }).map(course => ({
        courseName: course.courseName.trim(),
        grade: course.grade.trim(),
        courseType: course.courseType.trim()
      }));
    } catch (parseError) {
      console.error('Error parsing GPT response:', parseError);
      return res.status(500).json({ error: 'Failed to parse transcript data. Please try again or enter courses manually.' });
    }

    // Record successful upload
    recordTranscriptUpload(userId);

    res.json({ 
      success: true,
      courses: courses
    });
  } catch (error) {
    console.error('Transcript processing error:', error);
    res.status(500).json({ error: 'Failed to process transcript' });
  }
});

// Read CareerOneStop API credentials
let CAREERONESTOP_USER_ID = '';
let CAREERONESTOP_TOKEN = '';
try {
  CAREERONESTOP_USER_ID = fs.readFileSync(path.join(__dirname, 'activities-userId.txt'), 'utf8').trim();
  CAREERONESTOP_TOKEN = fs.readFileSync(path.join(__dirname, 'activities-token.txt'), 'utf8').trim();
} catch (error) {
  console.warn('Warning: CareerOneStop API credentials not found');
}

// Youth programs cache (indexed by zipcode)
let youthProgramsCache = {}; // { zipcode: [programs...] }
let allYouthPrograms = []; // All programs (for fallback or matching nearby zips)
let youthProgramsCacheTime = null;

const OPPORTUNITIES_CSV_PATH = path.join(__dirname, 'opprotunities.csv');
const ONETS_CSV_PATH = path.join(__dirname, 'ONETs.csv');

// Read ONETs from CSV file
function readONETsFromCSV() {
  try {
    if (!fs.existsSync(ONETS_CSV_PATH)) {
      return [];
    }

    const csvText = fs.readFileSync(ONETS_CSV_PATH, 'utf8');
    const lines = csvText.split('\n').filter(line => line.trim());
    
    if (lines.length <= 1) return []; // Only header or empty
    
    const jobs = [];
    
    for (let i = 1; i < lines.length; i++) {
      const values = [];
      let current = '';
      let inQuotes = false;
      
      // Parse CSV line (handling quoted values)
      for (let j = 0; j < lines[i].length; j++) {
        const char = lines[i][j];
        
        if (char === '"') {
          if (inQuotes && lines[i][j + 1] === '"') {
            current += '"';
            j++; // Skip next quote
          } else {
            inQuotes = !inQuotes;
          }
        } else if (char === ',' && !inQuotes) {
          values.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      values.push(current.trim()); // Add last value
      
      if (values.length >= 3) {
        jobs.push({
          jobZone: values[0] || '',
          code: values[1] || '',
          occupation: values[2] || '',
          dataLevel: values[3] || ''
        });
      }
    }
    
    return jobs;
  } catch (error) {
    console.error('Error reading ONETs CSV:', error);
    return [];
  }
}

// Read opportunities from CSV file
function readOpportunitiesFromCSV() {
  try {
    // Try both spellings (opportunities.csv and opprotunities.csv)
    let csvPath = OPPORTUNITIES_CSV_PATH;
    if (!fs.existsSync(csvPath)) {
      csvPath = path.join(__dirname, 'opportunities.csv');
      if (!fs.existsSync(csvPath)) {
        return null; // CSV doesn't exist
      }
    }

    const csvText = fs.readFileSync(csvPath, 'utf8');
    const lines = csvText.split('\n').filter(line => line.trim());
    
    if (lines.length <= 1) return []; // Only header or empty
    
    const headers = lines[0].split(',').map(h => h.trim());
    const programs = [];
    
    for (let i = 1; i < lines.length; i++) {
      const values = [];
      let current = '';
      let inQuotes = false;
      
      // Parse CSV line (handling quoted values)
      for (let j = 0; j < lines[i].length; j++) {
        const char = lines[i][j];
        
        if (char === '"') {
          if (inQuotes && lines[i][j + 1] === '"') {
            current += '"';
            j++; // Skip next quote
          } else {
            inQuotes = !inQuotes;
          }
        } else if (char === ',' && !inQuotes) {
          values.push(parseCSVValue(current.trim()));
          current = '';
        } else {
          current += char;
        }
      }
      values.push(parseCSVValue(current.trim())); // Last value
      
      // Create program object matching API format
      if (values.length >= headers.length) {
        const program = {};
        headers.forEach((header, index) => {
          program[header] = index < values.length ? values[index] : '';
        });
        
        // Convert CSV format to API response format
        const apiFormatProgram = {
          ID: program.ID || '',
          Name: program.Name || '',
          ProgramType: program.ProgramType || '',
          Address1: program.Address1 || '',
          Address2: program.Address2 || '',
          City: program.City || '',
          StateAbbr: program.StateAbbr || '',
          StateName: program.StateName || '',
          Zip: program.Zip || '',
          Phone: program.Phone || '',
          GeneralEmail: program.GeneralEmail || '',
          Fax: program.Fax || '',
          WebSiteUrl: program.WebSiteUrl || '',
          Latitude: program.Latitude ? parseFloat(program.Latitude) : null,
          Longitude: program.Longitude ? parseFloat(program.Longitude) : null,
          Distance: program.Distance || '',
          OpenHour: program.OpenHour || '',
          CenterIsOpen: program.CenterIsOpen || '',
          CenterStatus: program.CenterStatus || '',
          WhyClosed: program.WhyClosed || '',
          IsValid: program.IsValid || '',
          ServiceMessage: program.ServiceMessage || '',
          Contacts: []
        };
        
        // Add contact if available
        if (program.ContactName || program.ContactEmail || program.ContactPhone) {
          apiFormatProgram.Contacts = [{
            ContactName: program.ContactName || '',
            ContactEmail: program.ContactEmail || '',
            ContactPhone: program.ContactPhone || ''
          }];
        }
        
        programs.push(apiFormatProgram);
      }
    }
    
    return programs;
  } catch (error) {
    console.error('Error reading opportunities from CSV:', error);
    return null; // Return null to trigger API fallback
  }
}

// Refresh youth programs cache from CSV (or API if CSV missing)
async function refreshYouthPrograms() {
  try {
    // Try to load from CSV first
    const csvPrograms = readOpportunitiesFromCSV();
    if (csvPrograms !== null) {
      console.log(`✓ Loaded ${csvPrograms.length} youth programs from CSV`);
      
      // Index programs by zipcode (same logic as API version)
      const indexedByZip = {};
      allYouthPrograms = csvPrograms;
      
      csvPrograms.forEach(program => {
        const zip = program.Zip ? program.Zip.substring(0, 5).trim() : null;
        if (zip && /^\d{5}$/.test(zip)) {
          if (!indexedByZip[zip]) {
            indexedByZip[zip] = [];
          }
          indexedByZip[zip].push(program);
        }
        const zip3 = zip ? zip.substring(0, 3) : null;
        if (zip3 && /^\d{3}$/.test(zip3)) {
          const key3 = `zip3_${zip3}`;
          if (!indexedByZip[key3]) {
            indexedByZip[key3] = [];
          }
          indexedByZip[key3].push(program);
        }
      });

      youthProgramsCache = indexedByZip;
      youthProgramsCacheTime = Date.now();
      
      const totalPrograms = csvPrograms.length;
      const zipcodesWithPrograms = Object.keys(indexedByZip).filter(k => !k.startsWith('zip3_')).length;
      
      console.log(`✓ Youth programs cache refreshed: ${totalPrograms} programs indexed by ${zipcodesWithPrograms} zipcodes (from CSV)`);
      
      return csvPrograms;
    }
    
    // CSV not available, fall back to API
    console.log('CSV not found, fetching from API...');
    
    if (!CAREERONESTOP_USER_ID || !CAREERONESTOP_TOKEN) {
      console.warn('⚠ CareerOneStop API credentials not configured - cannot fetch youth programs');
      return [];
    }

    const url = `https://api.careeronestop.org/v1/youthprogramfinder/${CAREERONESTOP_USER_ID}?enableMetaData=false`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${CAREERONESTOP_TOKEN}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('CareerOneStop API error:', response.status, errorText);
      throw new Error(`API returned ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const programs = data.YouthProgramList || [];
    
    console.log(`✓ Fetched ${programs.length} youth programs from API`);
    
    // Index programs by zipcode (first 5 digits)
    const indexedByZip = {};
    allYouthPrograms = programs;
    
    programs.forEach(program => {
      const zip = program.Zip ? program.Zip.substring(0, 5).trim() : null;
      if (zip && /^\d{5}$/.test(zip)) {
        // Valid 5-digit zipcode
        if (!indexedByZip[zip]) {
          indexedByZip[zip] = [];
        }
        indexedByZip[zip].push(program);
      }
      // Also index by partial matches (3-digit prefix for nearby matches)
      const zip3 = zip ? zip.substring(0, 3) : null;
      if (zip3 && /^\d{3}$/.test(zip3)) {
        const key3 = `zip3_${zip3}`;
        if (!indexedByZip[key3]) {
          indexedByZip[key3] = [];
        }
        indexedByZip[key3].push(program);
      }
    });

    youthProgramsCache = indexedByZip;
    youthProgramsCacheTime = Date.now();
    
    const totalPrograms = programs.length;
    const zipcodesWithPrograms = Object.keys(indexedByZip).filter(k => !k.startsWith('zip3_')).length;
    
    console.log(`✓ Youth programs cache refreshed: ${totalPrograms} programs indexed by ${zipcodesWithPrograms} zipcodes (from API)`);
    
    return programs;
  } catch (error) {
    console.error('Error refreshing youth programs:', error);
    // Keep existing cache if refresh fails
    return allYouthPrograms;
  }
}

// Get youth programs by zipcode (from cache)
function getYouthProgramsByZipcode(zipcode) {
  if (!zipcode || !/^\d{5}$/.test(zipcode.trim())) {
    return [];
  }

  const zip = zipcode.trim().substring(0, 5);
  const zip3 = zip.substring(0, 3);
  
  // Get programs from exact zipcode match
  const exactMatch = youthProgramsCache[zip] || [];
  
  // Also get programs from 3-digit prefix (nearby zipcodes in same area)
  const nearbyMatch = youthProgramsCache[`zip3_${zip3}`] || [];
  
  // Combine both, but use a Set to avoid duplicates (programs might be in both)
  const programMap = new Map();
  
  // Add exact matches first (they get priority)
  exactMatch.forEach(program => {
    const key = program.ID || JSON.stringify(program);
    programMap.set(key, program);
  });
  
  // Add nearby matches (won't duplicate if already in exact match)
  nearbyMatch.forEach(program => {
    const key = program.ID || JSON.stringify(program);
    if (!programMap.has(key)) {
      programMap.set(key, program);
    }
  });
  
  return Array.from(programMap.values());
}

// Search ONETs by occupation name
app.get('/api/search-jobs', (req, res) => {
  try {
    const query = (req.query.q || '').toLowerCase().trim();
    
    if (!query) {
      return res.json([]);
    }
    
    const jobs = readONETsFromCSV();
    const matches = jobs.filter(job => 
      job.occupation.toLowerCase().includes(query) ||
      job.code.toLowerCase().includes(query)
    ).slice(0, 20); // Limit to 20 results
    
    res.json(matches);
  } catch (error) {
    console.error('Error searching jobs:', error);
    res.status(500).json({ error: 'Failed to search jobs' });
  }
});

// Get LMI (Labor Market Information) by ONET code
app.get('/api/career-lmi', async (req, res) => {
  try {
    const onetCode = req.query.onet_code;
    const location = req.query.location || 'US'; // Default to US if not provided
    
    if (!onetCode) {
      return res.status(400).json({ error: 'onet_code parameter is required' });
    }
    
    if (!CAREERONESTOP_USER_ID || !CAREERONESTOP_TOKEN) {
      return res.status(500).json({ error: 'CareerOneStop API credentials not configured' });
    }
    
    const url = `https://api.careeronestop.org/v1/lmi/${CAREERONESTOP_USER_ID}/${onetCode}/${encodeURIComponent(location)}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${CAREERONESTOP_TOKEN}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('CareerOneStop LMI API error:', response.status, errorText);
      return res.status(response.status).json({ error: `API error: ${errorText}` });
    }
    
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching career LMI:', error);
    res.status(500).json({ error: 'Failed to fetch career information' });
  }
});

// Get youth programs from CareerOneStop API (serves from cache)
// Zipcode lookup endpoint
app.get('/api/zipcode-lookup', async (req, res) => {
  try {
    const zipcode = req.query.zipcode?.trim();
    if (!zipcode) {
      return res.status(400).json({ error: 'Zipcode is required' });
    }

    // Read the zipcode CSV file (try stripped version first for faster lookups)
    let zipcodePath = path.join(__dirname, 'uszips_stripped.csv');
    if (!fs.existsSync(zipcodePath)) {
      zipcodePath = path.join(__dirname, 'uszips.csv');
      if (!fs.existsSync(zipcodePath)) {
        return res.status(404).json({ error: 'Zipcode database not found' });
      }
    }

    const csvContent = fs.readFileSync(zipcodePath, 'utf8');
    const lines = csvContent.split('\n');
    
    // Skip header line
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      // Parse CSV line (handling quoted values)
      const values = [];
      let current = '';
      let inQuotes = false;
      
      for (let j = 0; j < line.length; j++) {
        const char = line[j];
        if (char === '"') {
          if (j + 1 < line.length && line[j + 1] === '"' && inQuotes) {
            current += '"';
            j++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (char === ',' && !inQuotes) {
          let value = current.trim();
          if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1).replace(/""/g, '"');
          }
          values.push(value);
          current = '';
        } else {
          current += char;
        }
      }
      
      // Last value
      let value = current.trim();
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1).replace(/""/g, '"');
      }
      values.push(value);
      
      // Check if this zipcode matches
      // uszips_stripped.csv structure: zip,lat,lng (no quotes, 3 columns)
      // uszips.csv structure: "zip","lat","lng","city","state_id","state_name",... (quoted, many columns)
      const isStripped = zipcodePath.includes('uszips_stripped.csv');
      let zipValue, lat, lng, city, state_id, state_name;
      
      if (isStripped) {
        // Stripped version: zip,lat,lng (no quotes)
        zipValue = values[0]?.trim() || '';
        lat = parseFloat(values[1]?.trim() || 0);
        lng = parseFloat(values[2]?.trim() || 0);
        city = '';
        state_id = '';
        state_name = '';
      } else {
        // Full version: "zip","lat","lng","city","state_id","state_name",...
        zipValue = values[0]?.replace(/"/g, '') || '';
        lat = parseFloat(values[1]?.replace(/"/g, '') || 0);
        lng = parseFloat(values[2]?.replace(/"/g, '') || 0);
        city = values[3]?.replace(/"/g, '') || '';
        state_id = values[4]?.replace(/"/g, '') || '';
        state_name = values[5]?.replace(/"/g, '') || '';
      }
      
      if (zipValue === zipcode) {
        return res.json({
          zip: zipValue,
          lat: lat,
          lng: lng,
          city: city,
          state_id: state_id,
          state_name: state_name
        });
      }
    }
    
    res.status(404).json({ error: 'Zipcode not found' });
  } catch (error) {
    console.error('Error looking up zipcode:', error);
    res.status(500).json({ error: 'Failed to lookup zipcode' });
  }
});

app.get('/api/activities/youth-programs', async (req, res) => {
  try {
    const { zipcode } = req.query;
    
    if (!zipcode || !zipcode.trim()) {
      return res.status(400).json({ 
        error: 'Zipcode is required',
        programs: []
      });
    }

    // Get programs from cache
    const programs = getYouthProgramsByZipcode(zipcode);
    
    console.log(`Returning ${programs.length} programs for zipcode ${zipcode}`);
    
    res.json({ 
      success: true,
      programs: programs,
      recordCount: programs.length,
      cached: true,
      cacheTime: youthProgramsCacheTime
    });
  } catch (error) {
    console.error('Error getting youth programs:', error);
    res.status(500).json({ 
      error: 'Failed to get youth programs',
      programs: []
    });
  }
});

// Serve all HTML pages
const htmlPages = [
  'index.html', 'profile.html', 'odds.html', 'simulator.html', 
  'explorer.html', 'career.html', 'activities.html', 'scholarships.html', 'planner.html', 
  'messages.html', 'essay-assistant.html', 'saved.html', 'team.html', 'account.html'
];

htmlPages.forEach(page => {
  app.get(`/${page}`, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pages', page));
  });
  
  // Also handle without .html extension
  const route = page.replace('.html', '');
  if (route !== 'index') {
    app.get(`/${route}`, (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'pages', page));
    });
  }
});

// Serve index.html for root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pages', 'landing.html'));
});

// Cache for college data from API
let collegeDataCache = null;
let collegeDataCacheTime = null;
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

// Simple CSV parser
function parseCSVLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  
  for (let j = 0; j < line.length; j++) {
    const char = line[j];
    
    if (char === '"') {
      // Handle escaped quotes ("")
      if (j + 1 < line.length && line[j + 1] === '"' && inQuotes) {
        current += '"';
        j++; // Skip next quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      // Remove surrounding quotes from value
      let value = current.trim();
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1).replace(/""/g, '"');
      }
      values.push(value);
      current = '';
    } else {
      current += char;
    }
  }
  
  // Last value
  let value = current.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).replace(/""/g, '"');
  }
  values.push(value);
  
  return values;
}

// Simple CSV parser
function parseCSV(csvText) {
  const lines = csvText.split('\n').filter(line => line.trim());
  if (lines.length === 0) return [];
  
  // Parse header line
  const headers = parseCSVLine(lines[0]);
  const results = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    
    if (values.length >= headers.length) {
      const row = {};
      headers.forEach((header, index) => {
        row[header] = values[index] || '';
      });
      results.push(row);
    }
  }
  
  return results;
}

// Load college data from API
async function loadCollegeData() {
  try {
    const data = await fetchCollegeData();
    return data;
  } catch (error) {
    console.error('Error loading college data from API:', error);
    // Return cached data if available, otherwise empty array
    return collegeDataCache || [];
  }
}

// Get college data (with caching)
function getCollegeData() {
  // Return cached data synchronously
  // The cache will be refreshed asynchronously in the background
  return collegeDataCache || [];
}

// Refresh college data cache
async function refreshCollegeData() {
  try {
    const data = await loadCollegeData();
    collegeDataCache = data;
    collegeDataCacheTime = Date.now();
    console.log(`✓ College data cache refreshed: ${data.length} colleges`);
    
    return data;
  } catch (error) {
    console.error('Error refreshing college data:', error);
    // Keep existing cache if refresh fails
    return collegeDataCache || [];
  }
}

// Transform CSV row to API format
function transformCollege(row, index) {
  // Use ipeds_id as id if available, otherwise generate one
  const id = row.ipeds_id || `csv-${index}`;
  
  // Combine city and state for location
  const location = row.city && row.state 
    ? `${row.city}, ${row.state}` 
    : (row.city || row.state || 'Unknown');
  
  // Parse acceptance rate (should be decimal)
  let acceptanceRate = null;
  if (row.acceptance_rate) {
    const parsed = parseFloat(row.acceptance_rate);
    if (!isNaN(parsed)) acceptanceRate = parsed;
  }
  
  // Parse numeric values
  const parseNum = (val) => {
    if (!val || val === '') return null;
    const parsed = parseFloat(val);
    return isNaN(parsed) ? null : parsed;
  };
  
  return {
    id: id,
    name: row.name || 'Unknown',
    location: location,
    city: row.city || '',
    state: row.state || '',
    size: row.size_category || 'Unknown',
    type: row.type || 'Unknown',
    collegeYears: row.college_years || '',
    collegePublicPrivate: row.college_public_private || '',
    acceptanceRate: acceptanceRate,
    sat25thPercentile: parseNum(row.sat_25th_percentile),
    satAverage: parseNum(row.sat_50th_percentile),
    sat75thPercentile: parseNum(row.sat_75th_percentile),
    act25thPercentile: parseNum(row.act_25th_percentile),
    actMidpoint: parseNum(row.act_50th_percentile),
    act75thPercentile: parseNum(row.act_75th_percentile),
    tuitionInState: parseNum(row.tuition_in_state),
    tuitionOutState: parseNum(row.tuition_out_state),
    roomBoard: parseNum(row.room_board),
    graduationRate: parseNum(row.graduation_rate),
    retentionRate: parseNum(row.retention_rate),
    enrollment: parseNum(row.enrollment),
    studentFacultyRatio: parseNum(row.student_faculty_ratio),
    numMajors: parseNum(row.num_majors),
    collegeBoardCode: row.college_board_code || '',
    region: row.region || '',
    popularMajors: row.popular_majors || '',
    medianEarnings: parseNum(row.median_earnings_10_years),
    campusSetting: row.campus_setting || '',
    testOptional: row.test_optional === true || row.test_optional === 'True' || row.test_optional === 'true',
    gpaOptional: row.gpa_optional === true || row.gpa_optional === 'True' || row.gpa_optional === 'true',
    applicationDeadline: row.application_deadline_fall || '',
    applicationFee: parseNum(row.application_fee),
    averageFinancialAid: parseNum(row.average_financial_aid),
    avgAfterAid: parseNum(row.avg_after_aid),
    avgAfterAidCosts: parseNum(row.avg_after_aid_costs),
    percentReceivingAid: parseNum(row.percent_receiving_aid),
    transferAcceptanceRate: parseNum(row.transfer_acceptance_rate),
    latitude: parseNum(row.latitude),
    longitude: parseNum(row.longitude),
    housingAvailable: row.housing_available === 'True' || row.housing_available === 'true',
    url: row.url || '',
    rating: parseNum(row.rating) || null
  };
}

// Colleges API endpoint
app.get('/api/colleges', async (req, res) => {
  try {
    const { search, page = 1, per_page = 20 } = req.query;
    
    // Get all college data
    let colleges = getCollegeData();
    
    // Filter by search term if provided (on raw CSV data)
    if (search) {
      const searchLower = search.toLowerCase();
      colleges = colleges.filter(row => {
        const name = (row.name || '').toLowerCase();
        const city = (row.city || '').toLowerCase();
        const state = (row.state || '').toLowerCase();
        return name.includes(searchLower) || city.includes(searchLower) || state.includes(searchLower);
      });
    }
    
    // Transform to API format
    const transformed = colleges.map((row, index) => transformCollege(row, index));
    
    // Pagination
    const pageNum = parseInt(page) || 1;
    const perPage = parseInt(per_page) || 20;
    const start = (pageNum - 1) * perPage;
    const end = start + perPage;
    const paginated = transformed.slice(start, end);
    
    res.json({
      results: paginated,
      page: pageNum,
      per_page: perPage,
      total: transformed.length
    });
  } catch (error) {
    console.error('Error fetching college data:', error);
    res.status(500).json({ error: 'Failed to fetch college data' });
  }
});

// Accounts CSV file path
const ACCOUNTS_CSV_PATH = path.join(__dirname, 'storage', 'accounts.csv');
// Logins CSV file path
const LOGINS_CSV_PATH = path.join(__dirname, 'storage', 'logins.csv');
// Profile pictures CSV file path
const PROFILE_PICTURES_CSV_PATH = path.join(__dirname, 'storage', 'profile_pictures.csv');
// Password resets CSV file path
const PASSWORD_RESETS_CSV_PATH = path.join(__dirname, 'storage', 'password_resets.csv');
// Counselor messages CSV file path
const COUNSELOR_CSV_PATH = path.join(__dirname, 'storage', 'counselor.csv');
// Transcript uploads CSV file path
const TRANSCRIPT_UPLOADS_CSV_PATH = path.join(__dirname, 'storage', 'transcript_uploads.csv');

// Ensure storage directory exists
const storageDir = path.join(__dirname, 'storage');
if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir, { recursive: true });
}

// Initialize accounts CSV if it doesn't exist
if (!fs.existsSync(ACCOUNTS_CSV_PATH)) {
  const header = 'user_id,name,grade,academic_type,gpa,weighted,academic_courses,test_optional,sat,act,psat,majors,ap_courses,activities,interests,career_goals,rating,created_at,updated_at\n';
  fs.writeFileSync(ACCOUNTS_CSV_PATH, header, 'utf8');
}

// Initialize logins CSV if it doesn't exist
if (!fs.existsSync(LOGINS_CSV_PATH)) {
  const header = 'email,password_hash,user_id,created_at\n';
  fs.writeFileSync(LOGINS_CSV_PATH, header, 'utf8');
}

// Initialize profile pictures CSV if it doesn't exist
if (!fs.existsSync(PROFILE_PICTURES_CSV_PATH)) {
  const header = 'user_id,profile_picture_base64,updated_at\n';
  fs.writeFileSync(PROFILE_PICTURES_CSV_PATH, header, 'utf8');
}

// Initialize password resets CSV if it doesn't exist
if (!fs.existsSync(PASSWORD_RESETS_CSV_PATH)) {
  const header = 'email,reset_code,expires_at,created_at\n';
  fs.writeFileSync(PASSWORD_RESETS_CSV_PATH, header, 'utf8');
}

// Initialize counselor messages CSV if it doesn't exist
if (!fs.existsSync(COUNSELOR_CSV_PATH)) {
  const header = 'timestamp,user_id,direction,message\n';
  fs.writeFileSync(COUNSELOR_CSV_PATH, header, 'utf8');
}

// Initialize transcript uploads CSV if it doesn't exist
if (!fs.existsSync(TRANSCRIPT_UPLOADS_CSV_PATH)) {
  const header = 'user_id,date,timestamp\n';
  fs.writeFileSync(TRANSCRIPT_UPLOADS_CSV_PATH, header, 'utf8');
}

// Helper function to escape CSV values
function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  const stringValue = String(value);
  // If contains comma, quote, or newline, wrap in quotes and escape quotes
  if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

// Helper function to parse CSV value (handles quotes)
function parseCSVValue(value) {
  if (!value) return '';
  // Remove surrounding quotes if present
  if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
    // Unescape double quotes
    value = value.replace(/""/g, '"');
  }
  return value;
}

// Read all accounts from CSV
function readAccounts() {
  try {
    if (!fs.existsSync(ACCOUNTS_CSV_PATH)) {
      return [];
    }
    
    const csvText = fs.readFileSync(ACCOUNTS_CSV_PATH, 'utf8');
    const lines = csvText.split('\n').filter(line => line.trim());
    
    if (lines.length <= 1) return []; // Only header or empty
    
    const headers = lines[0].split(',').map(h => h.trim());
    const accounts = [];
    
    for (let i = 1; i < lines.length; i++) {
      const values = [];
      let current = '';
      let inQuotes = false;
      
      for (let j = 0; j < lines[i].length; j++) {
        const char = lines[i][j];
        
        if (char === '"') {
          if (inQuotes && lines[i][j + 1] === '"') {
            current += '"';
            j++; // Skip next quote
          } else {
            inQuotes = !inQuotes;
          }
        } else if (char === ',' && !inQuotes) {
          values.push(parseCSVValue(current.trim()));
          current = '';
        } else {
          current += char;
        }
      }
      values.push(parseCSVValue(current.trim())); // Last value
      
      // Process row even if it has fewer values than headers (for backward compatibility)
        const account = {};
        headers.forEach((header, index) => {
        let value = index < values.length ? values[index] : '';
          account[header] = value;
        });
        
        // Parse boolean and arrays
        if (account.weighted === 'true') account.weighted = true;
        else if (account.weighted === 'false') account.weighted = false;
        
        try {
          account.majors = account.majors ? JSON.parse(account.majors) : [];
        } catch (e) {
          account.majors = [];
        }
        
        try {
          account.ap_courses = account.ap_courses ? JSON.parse(account.ap_courses) : [];
        } catch (e) {
          account.ap_courses = [];
        }
      
      try {
        account.academic_courses = account.academic_courses ? JSON.parse(account.academic_courses) : [];
      } catch (e) {
        account.academic_courses = [];
      }
        
        try {
          account.interests = account.interests ? JSON.parse(account.interests) : [];
        } catch (e) {
          account.interests = [];
        }
        
        try {
          // Skip invalid "[object Object]" strings
          if (account.activities && account.activities.trim() === '[object Object]') {
            account.activities = [];
          }
          // Try to parse as JSON array first
          else if (account.activities && account.activities.trim().startsWith('[')) {
            account.activities = JSON.parse(account.activities);
          } else if (account.activities && account.activities.trim()) {
            // Legacy string format - convert to array format for consistency
            // Parse "X hrs — description" format
            const lines = account.activities.split('\n').map(l => l.trim()).filter(Boolean);
            account.activities = lines.map(line => {
              const match = line.match(/^(\d+)\s*(hrs?|hours?|h)?\s*[-–:]\s*(.+)$/i);
              if (match) {
                return { hours: match[1], description: match[3] };
              }
              return { hours: '', description: line };
            });
          } else {
            account.activities = [];
          }
        } catch (e) {
          // If parsing fails completely, default to empty array
          account.activities = [];
        }
        
        // Parse rating as number if it exists
        if (account.rating && account.rating !== '') {
          const ratingNum = parseFloat(account.rating);
          account.rating = !isNaN(ratingNum) ? ratingNum : null;
        } else {
          account.rating = null;
        }
        
        accounts.push(account);
    }
    
    return accounts;
  } catch (error) {
    console.error('Error reading accounts CSV:', error);
    return [];
  }
}

// Write accounts to CSV
function writeAccounts(accounts) {
  try {
    const headers = ['user_id', 'name', 'grade', 'zipcode', 'academic_type', 'gpa', 'weighted', 'academic_courses', 'test_optional', 'sat', 'act', 'psat', 'majors', 'ap_courses', 'activities', 'interests', 'career_goals', 'rating', 'created_at', 'updated_at'];
    
    let csv = headers.join(',') + '\n';
    
    accounts.forEach(account => {
      const row = headers.map(header => {
        let value = account[header];
        
        // Handle arrays and objects
        if (header === 'majors' || header === 'interests' || header === 'ap_courses' || header === 'activities' || header === 'academic_courses') {
          if (Array.isArray(value)) {
            value = JSON.stringify(value);
          } else if (value && typeof value === 'object') {
            // If it's an object but not an array, try to stringify it
            value = JSON.stringify(value);
          } else if (typeof value === 'string' && value.trim()) {
            // If it's already a string (from CSV), use it as-is (should be valid JSON)
            value = value;
          } else {
            // Default to empty array
            value = '[]';
          }
        } else {
          // For non-array fields, use empty string if undefined/null
          // Exception: rating should be empty string if null/undefined (not 'null')
          if (header === 'rating') {
            value = (value !== null && value !== undefined && value !== '') ? String(value) : '';
          } else {
            value = value || '';
          }
        }
        
        // Handle boolean
        if (header === 'weighted' || header === 'test_optional') {
          value = value === true ? 'true' : 'false';
        }
        
        return escapeCSV(value);
      });
      
      csv += row.join(',') + '\n';
    });
    
    fs.writeFileSync(ACCOUNTS_CSV_PATH, csv, 'utf8');
    return true;
  } catch (error) {
    console.error('Error writing accounts CSV:', error);
    return false;
  }
}

// Get account by user ID
function getAccount(userId) {
  const accounts = readAccounts();
  return accounts.find(acc => acc.user_id === userId) || null;
}

// Save or update account
function saveAccount(accountData) {
  const accounts = readAccounts();
  const existingIndex = accounts.findIndex(acc => acc.user_id === accountData.user_id);
  
  const now = new Date().toISOString();
  
  if (existingIndex >= 0) {
    // Update existing account
    accounts[existingIndex] = {
      ...accounts[existingIndex],
      ...accountData,
      updated_at: now
    };
  } else {
    // Create new account
    accounts.push({
      user_id: accountData.user_id,
      name: accountData.name || '',
      grade: accountData.grade || '',
      zipcode: accountData.zipcode || '',
      academic_type: accountData.academic_type || 'gpa',
      gpa: accountData.gpa || '',
      weighted: accountData.weighted !== undefined ? accountData.weighted : true,
      academic_courses: Array.isArray(accountData.academic_courses) ? accountData.academic_courses : [],
      test_optional: accountData.test_optional === true,
      sat: accountData.sat || '',
      act: accountData.act || '',
      psat: accountData.psat || '',
      majors: accountData.majors || [],
      ap_courses: accountData.ap_courses || [],
      activities: Array.isArray(accountData.activities) ? accountData.activities : [],
      interests: accountData.interests || [],
      career_goals: accountData.career_goals || accountData.careerGoals || '',
      rating: accountData.rating || null,
      created_at: now,
      updated_at: now
    });
  }
  
  return writeAccounts(accounts);
}

// Generate unique user ID
function generateUserId() {
  return 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Profile API endpoint - GET
app.get('/api/profile', async (req, res) => {
  try {
    const userId = req.query.user_id;
    
    if (!userId) {
      return res.status(400).json({ error: 'user_id parameter required' });
    }
    
    const account = getAccount(userId);
    
    if (!account) {
      // Return default profile if not found
      return res.json({
        user_id: userId,
        name: '',
        grade: '',
        zipcode: '',
        academicType: 'gpa',
        gpa: '',
        weighted: true,
        academicCourses: [],
        sat: '',
        act: '',
        psat: '',
        majors: [],
        apCourses: [],
        activities: '',
        interests: [],
        careerGoals: '',
        rating: null
      });
    }
    
    // Only return rating if it exists in the account (profile was saved and rated)
    // Don't calculate on-the-fly - rating should only exist after profile is saved
    // Parse rating as number (it comes from CSV as string)
    let studentRating = null;
    if (account.rating !== null && account.rating !== undefined && account.rating !== '') {
      const ratingNum = typeof account.rating === 'string' ? parseFloat(account.rating) : account.rating;
      studentRating = !isNaN(ratingNum) ? ratingNum : null;
    }
    
    // Transform to frontend format
    res.json({
      user_id: account.user_id,
      name: account.name || '',
      grade: account.grade || '',
      zipcode: account.zipcode || '',
      academicType: account.academic_type || 'gpa',
      gpa: account.gpa || '',
      weighted: account.weighted !== undefined ? account.weighted : true,
      academicCourses: Array.isArray(account.academic_courses) ? account.academic_courses : [],
      testOptional: account.test_optional === true,
      sat: account.sat || '',
      act: account.act || '',
      psat: account.psat || '',
      majors: account.majors || [],
      apCourses: account.ap_courses || [],
      activities: Array.isArray(account.activities) ? account.activities : [], // Return as array (legacy strings are converted to [] in readAccounts)
      interests: account.interests || [],
      careerGoals: account.career_goals || '',
      rating: studentRating
    });
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Profile API endpoint - POST (create/update)
app.post('/api/profile', async (req, res) => {
  try {
    const profileData = req.body;
    
    if (!profileData.user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    // Compute a private rating for this student (not returned to client)
    let rating = null;
    try {
      // Calculate GPA from academic courses if using courses mode
      let calculatedGpa = profileData.gpa;
      let isWeighted = profileData.weighted;
      
      if (profileData.academicType === 'courses' && profileData.academicCourses && profileData.academicCourses.length > 0) {
        // Convert letter grades to GPA points
        const gradeToPoints = {
          'A+': 4.0, 'A': 4.0, 'A-': 3.7,
          'B+': 3.3, 'B': 3.0, 'B-': 2.7,
          'C+': 2.3, 'C': 2.0, 'C-': 1.7,
          'D+': 1.3, 'D': 1.0, 'D-': 0.7,
          'F': 0.0
        };
        
        // For weighted GPA, add 1.0 point for AP/Honors courses (we'll assume courses with "AP" or "Honors" in name are weighted)
        const validCourses = profileData.academicCourses.filter(c => c && c.grade && c.grade !== '');
        if (validCourses.length > 0) {
          let totalPoints = 0;
          let totalCourses = 0;
          
          validCourses.forEach(course => {
            const grade = course.grade.trim();
            const courseName = (course.courseName || '').toLowerCase();
            let points = gradeToPoints[grade] || 0;
            
            // Check if it's an AP or Honors course for weighted GPA
            const isWeightedCourse = courseName.includes('ap') || courseName.includes('honors') || courseName.includes('honor');
            if (isWeightedCourse && points > 0) {
              points += 1.0; // Add 1.0 for weighted courses (cap at 5.0 for A+)
              points = Math.min(5.0, points);
            }
            
            totalPoints += points;
            totalCourses++;
          });
          
          if (totalCourses > 0) {
            calculatedGpa = (totalPoints / totalCourses).toFixed(2);
            // If any course is weighted, assume overall GPA is weighted
            const hasWeightedCourse = validCourses.some(c => {
              const name = (c.courseName || '').toLowerCase();
              return name.includes('ap') || name.includes('honors') || name.includes('honor');
            });
            if (hasWeightedCourse) {
              isWeighted = true;
            }
          }
        }
      }
      
      const calculatedRating = await rateStudent({
        gpa: calculatedGpa,
        weighted: isWeighted,
        sat: profileData.sat,
        act: profileData.act,
        testOptional: profileData.testOptional === true,
        apCourses: profileData.apCourses || [],
        activities: profileData.activities || [] // Pass as array (rateStudent handles conversion)
      });
      // Only set rating if it's a valid number
      if (calculatedRating !== null && calculatedRating !== undefined && !isNaN(calculatedRating)) {
        rating = calculatedRating;
      }
    } catch (e) {
      console.error('Error rating student profile:', e);
      rating = null;
    }
    
    // Transform frontend format to backend format
    const accountData = {
      user_id: profileData.user_id,
      name: profileData.name || '',
      grade: profileData.grade || '',
      zipcode: profileData.zipcode || '',
      academic_type: profileData.academicType || 'gpa',
      gpa: profileData.gpa || '',
      weighted: profileData.weighted !== undefined ? profileData.weighted : true,
      academic_courses: Array.isArray(profileData.academicCourses) ? profileData.academicCourses : [],
      test_optional: profileData.testOptional === true,
      sat: profileData.sat || '',
      act: profileData.act || '',
      psat: profileData.psat || '',
      majors: profileData.majors || [],
      ap_courses: profileData.apCourses || [],
      activities: Array.isArray(profileData.activities) ? profileData.activities : [], // Store as array
      interests: profileData.interests || [],
      career_goals: profileData.careerGoals || profileData.career_goals || '',
      rating: rating
    };
    
    const success = saveAccount(accountData);
    
    if (success) {
      res.json({ success: true, message: 'Profile saved successfully' });
    } else {
      res.status(500).json({ error: 'Failed to save profile' });
    }
  } catch (error) {
    console.error('Error saving profile:', error);
    res.status(500).json({ error: 'Failed to save profile' });
  }
});

// Generate user ID endpoint
app.get('/api/user-id', (req, res) => {
  const userId = generateUserId();
  res.json({ user_id: userId });
});

// Calculate student rating endpoint (for simulator)
app.post('/api/calculate-rating', async (req, res) => {
  try {
    const profileData = req.body;
    
    // Calculate rating using rateStudent
    const calculatedRating = await rateStudent({
      gpa: profileData.gpa,
      weighted: profileData.weighted !== undefined ? profileData.weighted : true,
      sat: profileData.sat,
      act: profileData.act,
      testOptional: profileData.testOptional === true,
      apCourses: profileData.apCourses || [],
      activities: profileData.activities || []
    });
    
    res.json({ rating: calculatedRating });
  } catch (error) {
    console.error('Error calculating rating:', error);
    res.status(500).json({ error: 'Failed to calculate rating' });
  }
});

// Authentication endpoints

// Read logins from CSV
function readLogins() {
  try {
    if (!fs.existsSync(LOGINS_CSV_PATH)) {
      return [];
    }

    const csvText = fs.readFileSync(LOGINS_CSV_PATH, 'utf8');
    const lines = csvText.split('\n').filter(line => line.trim());
    
    if (lines.length < 2) {
      return [];
    }

    const headers = parseCSVLine(lines[0]);
    const logins = [];
    
    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
      if (values.length === headers.length) {
        const login = {};
        headers.forEach((header, index) => {
          login[header] = values[index] || '';
        });
        logins.push(login);
      }
    }
    
    return logins;
  } catch (error) {
    console.error('Error reading logins CSV:', error);
    return [];
  }
}

// Write logins to CSV
function writeLogins(logins) {
  try {
    const headers = ['email', 'password_hash', 'user_id', 'created_at'];
    let csv = headers.join(',') + '\n';
    
    logins.forEach(login => {
      const row = headers.map(header => {
        let value = login[header] || '';
        // Escape quotes and wrap in quotes if contains comma or newline
        if (typeof value === 'string' && (value.includes(',') || value.includes('\n') || value.includes('"'))) {
          value = '"' + value.replace(/"/g, '""') + '"';
        }
        return value;
      });
      csv += row.join(',') + '\n';
    });
    
    fs.writeFileSync(LOGINS_CSV_PATH, csv, 'utf8');
    return true;
  } catch (error) {
    console.error('Error writing logins CSV:', error);
    return false;
  }
}

// Sign up endpoint
app.post('/api/auth/signup', (req, res) => {
  try {
    const { email, password_hash } = req.body;
    
    if (!email || !password_hash) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    const logins = readLogins();
    
    // Check if email already exists
    const existingLogin = logins.find(login => login.email === email.toLowerCase().trim());
    if (existingLogin) {
      return res.status(400).json({ success: false, error: 'An account with this email already exists' });
    }

    // Create new user
    const userId = generateUserId();
    const now = new Date().toISOString();
    
    const newLogin = {
      email: email.toLowerCase().trim(),
      password_hash: password_hash,
      user_id: userId,
      created_at: now
    };

    logins.push(newLogin);
    
    if (writeLogins(logins)) {
      // Also create an entry in accounts.csv for this user
      const accounts = readAccounts();
      accounts.push({
        user_id: userId,
        name: '',
        grade: '',
        academic_type: 'gpa',
        gpa: '',
        weighted: true,
        academic_courses: [],
        test_optional: false,
        sat: '',
        act: '',
        psat: '',
        majors: [],
        ap_courses: [],
        activities: [],
        interests: [],
        career_goals: '',
        rating: null,
        created_at: now,
        updated_at: now
      });
      writeAccounts(accounts);
      
      res.json({ success: true, userId: userId });
    } else {
      res.status(500).json({ success: false, error: 'Failed to create account' });
    }
  } catch (error) {
    console.error('Sign up error:', error);
    res.status(500).json({ success: false, error: 'An error occurred' });
  }
});

// Sign in endpoint
app.post('/api/auth/login', (req, res) => {
  try {
    const { email, password_hash } = req.body;
    
    if (!email || !password_hash) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    const logins = readLogins();
    const login = logins.find(l => l.email === email.toLowerCase().trim() && l.password_hash === password_hash);
    
    if (login) {
      res.json({ success: true, userId: login.user_id });
    } else {
      res.status(401).json({ success: false, error: 'Invalid email or password' });
    }
  } catch (error) {
    console.error('Sign in error:', error);
    res.status(500).json({ success: false, error: 'An error occurred' });
  }
});

// Password reset functions
function readPasswordResets() {
  try {
    if (!fs.existsSync(PASSWORD_RESETS_CSV_PATH)) {
      return [];
    }

    const csvText = fs.readFileSync(PASSWORD_RESETS_CSV_PATH, 'utf8');
    const lines = csvText.split('\n').filter(line => line.trim());
    
    if (lines.length < 2) {
      return [];
    }

    const headers = parseCSVLine(lines[0]);
    const resets = [];
    
    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
      if (values.length === headers.length) {
        const reset = {};
        headers.forEach((header, index) => {
          reset[header] = values[index] || '';
        });
        resets.push(reset);
      }
    }
    
    return resets;
  } catch (error) {
    console.error('Error reading password resets CSV:', error);
    return [];
  }
}

function writePasswordResets(resets) {
  try {
    const headers = ['email', 'reset_code', 'expires_at', 'created_at'];
    let csv = headers.join(',') + '\n';
    
    resets.forEach(reset => {
      const row = headers.map(header => {
        let value = reset[header] || '';
        // Escape quotes and wrap in quotes if contains comma or newline
        if (typeof value === 'string' && (value.includes(',') || value.includes('\n') || value.includes('"'))) {
          value = '"' + value.replace(/"/g, '""') + '"';
        }
        return value;
      });
      csv += row.join(',') + '\n';
    });
    
    fs.writeFileSync(PASSWORD_RESETS_CSV_PATH, csv, 'utf8');
    return true;
  } catch (error) {
    console.error('Error writing password resets CSV:', error);
    return false;
  }
}

function generateResetCode() {
  // Generate a 6-digit code
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Forgot password endpoint
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }

    const logins = readLogins();
    const login = logins.find(l => l.email === email.toLowerCase().trim());
    
    if (!login) {
      // Don't reveal that the email doesn't exist (security best practice)
      return res.json({ success: true, message: 'If an account exists with this email, a reset code has been sent.' });
    }

    // Generate reset code
    const resetCode = generateResetCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000); // 15 minutes from now

    // Store reset code
    const resets = readPasswordResets();
    
    // Remove any existing reset codes for this email
    const filteredResets = resets.filter(r => r.email !== email.toLowerCase().trim());
    
    // Add new reset code
    filteredResets.push({
      email: email.toLowerCase().trim(),
      reset_code: resetCode,
      expires_at: expiresAt.toISOString(),
      created_at: now.toISOString()
    });
    
    writePasswordResets(filteredResets);

    // Send email with reset code
    if (emailTransporter) {
      const emailHtml = `
        <h2>Password Reset Request</h2>
        <p>You requested to reset your password for your Path Pal account.</p>
        <p style="font-size: 1.2em; font-weight: bold; color: #0d8c79; margin: 1.5em 0;">Your reset code is: <strong>${resetCode}</strong></p>
        <p>This code will expire in 15 minutes.</p>
        <p>If you didn't request this reset, you can safely ignore this email.</p>
        <p style="color: #666; font-size: 0.9em; margin-top: 2em;">Sent from Path Pal at ${now.toLocaleString()}</p>
      `;

      await sendEmail(email, 'Path Pal Password Reset', emailHtml);
    } else {
      console.error('Email transporter not configured - cannot send reset code');
      return res.status(500).json({ success: false, error: 'Email service is not configured. Please contact support.' });
    }

    res.json({ success: true, message: 'Reset code sent to your email' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ success: false, error: 'An error occurred' });
  }
});

// Reset password endpoint
app.post('/api/auth/reset-password', (req, res) => {
  try {
    const { email, code, password_hash } = req.body;
    
    if (!email || !code || !password_hash) {
      return res.status(400).json({ success: false, error: 'Email, code, and password are required' });
    }

    const resets = readPasswordResets();
    const reset = resets.find(r => 
      r.email === email.toLowerCase().trim() && 
      r.reset_code === code.trim()
    );

    if (!reset) {
      return res.status(400).json({ success: false, error: 'Invalid or expired reset code' });
    }

    // Check if code has expired
    const expiresAt = new Date(reset.expires_at);
    const now = new Date();
    
    if (now > expiresAt) {
      // Remove expired code
      const filteredResets = resets.filter(r => 
        !(r.email === email.toLowerCase().trim() && r.reset_code === code.trim())
      );
      writePasswordResets(filteredResets);
      
      return res.status(400).json({ success: false, error: 'Reset code has expired. Please request a new one.' });
    }

    // Update password in logins
    const logins = readLogins();
    const loginIndex = logins.findIndex(l => l.email === email.toLowerCase().trim());
    
    if (loginIndex === -1) {
      return res.status(400).json({ success: false, error: 'User not found' });
    }

    logins[loginIndex].password_hash = password_hash;
    writeLogins(logins);

    // Remove used reset code
    const filteredResets = resets.filter(r => 
      !(r.email === email.toLowerCase().trim() && r.reset_code === code.trim())
    );
    writePasswordResets(filteredResets);

    res.json({ success: true, message: 'Password reset successfully' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ success: false, error: 'An error occurred' });
  }
});

// Get user email by user_id
app.get('/api/user/email', (req, res) => {
  try {
    const { user_id } = req.query;
    
    if (!user_id) {
      return res.status(400).json({ success: false, error: 'User ID is required' });
    }

    const logins = readLogins();
    const login = logins.find(l => l.user_id === user_id);
    
    if (login) {
      res.json({ success: true, email: login.email });
    } else {
      res.status(404).json({ success: false, error: 'User not found' });
    }
  } catch (error) {
    console.error('Get user email error:', error);
    res.status(500).json({ success: false, error: 'An error occurred' });
  }
});

// Delete account endpoint
app.post('/api/account/delete', (req, res) => {
  try {
    const { user_id, password_hash } = req.body;
    
    if (!user_id || !password_hash) {
      return res.status(400).json({ success: false, error: 'User ID and password are required' });
    }

    // Verify password
    const logins = readLogins();
    const login = logins.find(l => l.user_id === user_id && l.password_hash === password_hash);
    
    if (!login) {
      return res.status(401).json({ success: false, error: 'Invalid password' });
    }

    // Remove from logins
    const filteredLogins = logins.filter(l => l.user_id !== user_id);
    writeLogins(filteredLogins);

    // Remove from accounts
    const accounts = readAccounts();
    const filteredAccounts = accounts.filter(a => a.user_id !== user_id);
    writeAccounts(filteredAccounts);

    // Remove profile picture
    const pictures = readProfilePictures();
    const filteredPictures = pictures.filter(p => p.user_id !== user_id);
    writeProfilePictures(filteredPictures);

    res.json({ success: true, message: 'Account deleted successfully' });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ success: false, error: 'An error occurred' });
  }
});

// Profile picture endpoints

// Read profile pictures from CSV
function readProfilePictures() {
  try {
    if (!fs.existsSync(PROFILE_PICTURES_CSV_PATH)) {
      return [];
    }

    const csvText = fs.readFileSync(PROFILE_PICTURES_CSV_PATH, 'utf8');
    const lines = csvText.split('\n').filter(line => line.trim());
    
    if (lines.length < 2) {
      return [];
    }

    const headers = parseCSVLine(lines[0]);
    const pictures = [];
    
    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
      if (values.length === headers.length) {
        const picture = {};
        headers.forEach((header, index) => {
          picture[header] = values[index] || '';
        });
        pictures.push(picture);
      }
    }
    
    return pictures;
  } catch (error) {
    console.error('Error reading profile pictures CSV:', error);
    return [];
  }
}

// Write profile pictures to CSV
function writeProfilePictures(pictures) {
  try {
    const headers = ['user_id', 'profile_picture_base64', 'updated_at'];
    let csv = headers.join(',') + '\n';
    
    pictures.forEach(picture => {
      const row = headers.map(header => {
        let value = picture[header] || '';
        // Escape quotes and wrap in quotes if contains comma or newline
        if (typeof value === 'string' && (value.includes(',') || value.includes('\n') || value.includes('"'))) {
          value = '"' + value.replace(/"/g, '""') + '"';
        }
        return value;
      });
      csv += row.join(',') + '\n';
    });
    
    fs.writeFileSync(PROFILE_PICTURES_CSV_PATH, csv, 'utf8');
    return true;
  } catch (error) {
    console.error('Error writing profile pictures CSV:', error);
    return false;
  }
}

// Save profile picture endpoint
app.post('/api/profile/picture', (req, res) => {
  try {
    const { user_id, profile_picture_base64 } = req.body;
    
    if (!user_id) {
      return res.status(400).json({ success: false, error: 'User ID is required' });
    }

    if (!profile_picture_base64) {
      return res.status(400).json({ success: false, error: 'Profile picture is required' });
    }

    const pictures = readProfilePictures();
    const existingIndex = pictures.findIndex(p => p.user_id === user_id);
    const now = new Date().toISOString();

    if (existingIndex >= 0) {
      // Update existing
      pictures[existingIndex] = {
        user_id: user_id,
        profile_picture_base64: profile_picture_base64,
        updated_at: now
      };
    } else {
      // Create new
      pictures.push({
        user_id: user_id,
        profile_picture_base64: profile_picture_base64,
        updated_at: now
      });
    }

    if (writeProfilePictures(pictures)) {
      res.json({ success: true });
    } else {
      res.status(500).json({ success: false, error: 'Failed to save profile picture' });
    }
  } catch (error) {
    console.error('Error saving profile picture:', error);
    res.status(500).json({ success: false, error: 'An error occurred' });
  }
});

// Get profile picture endpoint
app.get('/api/profile/picture', (req, res) => {
  try {
    const { user_id } = req.query;
    
    if (!user_id) {
      return res.status(400).json({ success: false, error: 'User ID is required' });
    }

    const pictures = readProfilePictures();
    const picture = pictures.find(p => p.user_id === user_id);
    
    if (picture && picture.profile_picture_base64) {
      res.json({ success: true, profile_picture: picture.profile_picture_base64 });
    } else {
      res.json({ success: true, profile_picture: null });
    }
  } catch (error) {
    console.error('Error getting profile picture:', error);
    res.status(500).json({ success: false, error: 'An error occurred' });
  }
});

// Health check endpoint for Render
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Test email endpoint (for development/testing)
app.post('/api/email/test', async (req, res) => {
  try {
    const { to } = req.body;
    
    if (!to) {
      return res.status(400).json({ success: false, error: 'Email address is required' });
    }

    if (!emailTransporter) {
      return res.status(500).json({ success: false, error: 'Email transporter not configured. Please add your email API key to email-key.txt' });
    }

    const testHtml = `
      <h2>Test Email from Path Pal</h2>
      <p>This is a test email to verify that your email configuration is working correctly.</p>
      <p>If you received this email, your email API is properly configured!</p>
      <p style="color: #666; font-size: 0.9em; margin-top: 2em;">Sent from Path Pal at ${new Date().toLocaleString()}</p>
    `;

    const success = await sendEmail(to, 'Path Pal Email Test', testHtml);

    if (success) {
      res.json({ success: true, message: 'Test email sent successfully' });
    } else {
      res.status(500).json({ success: false, error: 'Failed to send test email' });
    }
  } catch (error) {
    console.error('Test email error:', error);
    res.status(500).json({ success: false, error: 'An error occurred while sending test email' });
  }
});

// API endpoint for college news
app.get('/api/news', async (req, res) => {
  try {
    if (!NEWS_API_KEY) {
      // Return empty results if no API key
      return res.json({ articles: [] });
    }

    let allArticles = [];

    // First, try to get headlines from education category (more reliable)
    try {
      const headlinesUrl = `https://newsapi.org/v2/top-headlines?category=education&country=us&pageSize=10&apiKey=${NEWS_API_KEY}`;
      const headlinesResponse = await fetch(headlinesUrl);
      const headlinesData = await headlinesResponse.json();
      
      if (headlinesData.status === 'ok' && headlinesData.articles) {
        allArticles = allArticles.concat(headlinesData.articles);
      }
    } catch (err) {
      console.error('Error fetching education headlines:', err);
    }

    // Also search for specific college-related terms
    const searchQueries = [
      encodeURIComponent('"college admissions" OR "university admissions" OR "college application"'),
      encodeURIComponent('(SAT OR ACT) AND (college OR university OR admission)'),
      encodeURIComponent('"financial aid" OR "college tuition" OR "scholarship"')
    ];

    // Fetch from search queries
    for (const query of searchQueries.slice(0, 2)) { // Use first 2 queries to avoid rate limits
      try {
        const url = `https://newsapi.org/v2/everything?q=${query}&language=en&sortBy=publishedAt&pageSize=10&apiKey=${NEWS_API_KEY}`;
        const response = await fetch(url);
        const data = await response.json();

        if (data.status === 'ok' && data.articles) {
          allArticles = allArticles.concat(data.articles);
        }
      } catch (err) {
        console.error('Error fetching news query:', err);
      }
    }

    // Filter for relevance - check if title/description contains college-related keywords
    const relevanceKeywords = [
      'college', 'university', 'admission', 'admissions', 'SAT', 'ACT', 
      'financial aid', 'tuition', 'scholarship', 'student', 'applicant',
      'higher education', 'enrollment', 'acceptance', 'application'
    ];

    const relevantArticles = allArticles
      .filter(article => {
        if (!article.title || !article.url || !article.publishedAt) return false;
        
        const titleLower = (article.title || '').toLowerCase();
        const descLower = (article.description || '').toLowerCase();
        const combined = titleLower + ' ' + descLower;
        
        // Must contain at least one college-related keyword
        return relevanceKeywords.some(keyword => combined.includes(keyword.toLowerCase()));
      })
      .filter(article => {
        // Exclude articles that are clearly not about college (sports, entertainment, etc.)
        const titleLower = (article.title || '').toLowerCase();
        const excludeTerms = ['nfl', 'nba', 'mlb', 'soccer', 'football game', 'basketball game', 'movie', 'tv show', 'celebrity'];
        return !excludeTerms.some(term => titleLower.includes(term));
      })
      // Remove duplicates based on URL
      .filter((article, index, self) => 
        index === self.findIndex(a => a.url === article.url)
      )
      .slice(0, 5) // Limit to 5 articles
      .map(article => ({
        title: article.title,
        description: article.description || '',
        url: article.url,
        publishedAt: article.publishedAt,
        source: article.source?.name || 'News',
        imageUrl: article.urlToImage || null
      }));

    res.json({ articles: relevantArticles });
  } catch (error) {
    console.error('Error fetching news:', error);
    res.json({ articles: [] });
  }
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Path Pal server running on port ${PORT}`);
  if (GPT_API_KEY) {
    console.log('✓ GPT API key configured');
  } else {
    console.warn('⚠ Warning: GPT API key not configured. AI features will not work.');
  }
  
  // Check API health
  const healthCheck = await checkApiHealth();
  if (healthCheck.healthy) {
    console.log(`✓ College data API health check: ${healthCheck.status}`);
  } else {
    console.warn(`⚠ College data API health check: ${healthCheck.status}`);
  }
  
  // Load college data on startup
  await refreshCollegeData();
  
  const collegeCount = getCollegeData().length;
  if (collegeCount > 0) {
    console.log(`✓ Loaded ${collegeCount} colleges from API`);
  } else {
    console.warn('⚠ Warning: No college data loaded from API');
  }
  
  // Load youth programs on startup
  await refreshYouthPrograms();
  
  // Set up 24-hour interval to refresh college data
  setInterval(async () => {
    console.log('Refreshing college data (24-hour interval)...');
    await refreshCollegeData();
  }, 24 * 60 * 60 * 1000); // 24 hours in milliseconds
  
  // Set up 24-hour interval to refresh youth programs
  setInterval(async () => {
    console.log('Refreshing youth programs (24-hour interval)...');
    await refreshYouthPrograms();
  }, 24 * 60 * 60 * 1000); // 24 hours in milliseconds
  
  // Initialize accounts storage
  if (fs.existsSync(ACCOUNTS_CSV_PATH)) {
    const accounts = readAccounts();
    console.log(`✓ Accounts storage initialized with ${accounts.length} account(s)`);
  } else {
    console.log('✓ Accounts storage initialized (empty)');
  }
  
  // Initialize logins storage
  if (fs.existsSync(LOGINS_CSV_PATH)) {
    const logins = readLogins();
    console.log(`✓ Logins storage initialized with ${logins.length} login(s)`);
  } else {
    console.log('✓ Logins storage initialized (empty)');
  }
  
  // Initialize profile pictures storage
  if (fs.existsSync(PROFILE_PICTURES_CSV_PATH)) {
    const pictures = readProfilePictures();
    console.log(`✓ Profile pictures storage initialized with ${pictures.length} picture(s)`);
  } else {
    console.log('✓ Profile pictures storage initialized (empty)');
  }

  // Initialize password resets storage
  if (fs.existsSync(PASSWORD_RESETS_CSV_PATH)) {
    const resets = readPasswordResets();
    // Clean up expired resets on startup
    const now = new Date();
    const activeResets = resets.filter(r => new Date(r.expires_at) > now);
    if (activeResets.length < resets.length) {
      writePasswordResets(activeResets);
      console.log(`✓ Password resets storage initialized with ${activeResets.length} active reset(s) (cleaned up ${resets.length - activeResets.length} expired)`);
    } else {
      console.log(`✓ Password resets storage initialized with ${resets.length} active reset(s)`);
    }
  } else {
    console.log('✓ Password resets storage initialized (empty)');
  }
});

