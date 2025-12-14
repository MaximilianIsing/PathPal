/**
 * Fetches college data from the API endpoint
 * Transforms the API response to match the expected format
 */

const fs = require('fs');
const path = require('path');

const API_URL = 'https://path-pal-college-scanner.onrender.com/getdata?key=23176427708775045798948882391414';
const API_HEALTH_URL = 'https://path-pal-college-scanner.onrender.com/health';
const USE_BACKUP_FILE = path.join(__dirname, 'use-backup.txt');
const BACKUP_CSV_PATH = path.join(__dirname, 'data-backup.csv');
const BACKUP_JSON_PATH = path.join(__dirname, 'data-backup.json');

/**
 * Transform API college object to internal format
 */
function transformApiCollege(apiCollege, index) {
  // Parse numeric values
  const parseNum = (val) => {
    if (!val || val === '' || val === null || val === undefined) return null;
    const parsed = parseFloat(val);
    return isNaN(parsed) ? null : parsed;
  };

  // Parse acceptance rate (API returns as percentage string like "0.5")
  let acceptanceRate = null;
  if (apiCollege.acceptance_rate_pct) {
    const parsed = parseFloat(apiCollege.acceptance_rate_pct);
    if (!isNaN(parsed)) acceptanceRate = parsed;
  }

  // Determine size category from enrollment
  let sizeCategory = 'Unknown';
  const enrollment = parseNum(apiCollege.undergrad_students_num);
  if (enrollment !== null) {
    if (enrollment < 5000) {
      sizeCategory = 'Small';
    } else if (enrollment <= 15000) {
      sizeCategory = 'Medium';
    } else {
      sizeCategory = 'Large';
    }
  }

  // Map API fields to internal format
  return {
    name: apiCollege.name || 'Unknown',
    city: '', // API doesn't provide city separately
    state: '', // API doesn't provide state separately
    location: '', // Will be constructed if needed
    size_category: sizeCategory,
    type: apiCollege.college_type || apiCollege.college_public_private || 'Unknown',
    college_years: apiCollege.college_years || '',
    college_public_private: apiCollege.college_public_private || '',
    acceptance_rate: acceptanceRate,
    sat_25th_percentile: parseNum(apiCollege.sat_25th_percentile),
    sat_50th_percentile: parseNum(apiCollege.sat_50th_percentile),
    sat_75th_percentile: parseNum(apiCollege.sat_75th_percentile),
    act_25th_percentile: parseNum(apiCollege.act_25th_percentile),
    act_50th_percentile: parseNum(apiCollege.act_50th_percentile),
    act_75th_percentile: parseNum(apiCollege.act_75th_percentile),
    tuition_in_state: null, // API doesn't provide this separately
    tuition_out_state: parseNum(apiCollege.avg_after_aid_costs_val), // Using avg_after_aid_costs as approximation
    room_board: parseNum(apiCollege.avg_housing_cost_val),
    graduation_rate: parseNum(apiCollege.graduation_rate_pct),
    retention_rate: parseNum(apiCollege.retention_rate_pct),
    enrollment: enrollment,
    student_faculty_ratio: parseNum(apiCollege.student_faculty_ratio_num),
    num_majors: parseNum(apiCollege.num_majors_num),
    college_board_code: apiCollege.college_board_code_num || '',
    region: '', // API doesn't provide region
    popular_majors: '', // API doesn't provide popular majors
    median_earnings_10_years: null, // API doesn't provide this
    campus_setting: apiCollege.setting || '',
    test_optional: apiCollege.test_optional === 'Yes' || apiCollege.test_optional === true || apiCollege.test_optional === 'yes',
    gpa_optional: apiCollege.gpa_optional === 'Yes' || apiCollege.gpa_optional === true || apiCollege.gpa_optional === 'yes',
    application_deadline_fall: apiCollege.rd_due_date || '',
    application_fee: null, // API doesn't provide this
    average_financial_aid: parseNum(apiCollege.avg_aid_package_val),
    avg_after_aid: parseNum(apiCollege.avg_after_aid_val),
    avg_after_aid_costs: parseNum(apiCollege.avg_after_aid_costs_val),
    percent_receiving_aid: parseNum(apiCollege.pct_receiving_aid_pct),
    transfer_acceptance_rate: null, // API doesn't provide this
    latitude: null, // API doesn't provide this
    longitude: null, // API doesn't provide this
    housing_available: null, // API doesn't provide this explicitly
    url: '', // API doesn't provide URL
    ipeds_id: '', // API doesn't provide IPEDS ID
    rating: parseNum(apiCollege.college_score) || null
  };
}

/**
 * Check if use-backup.txt exists and returns true/false
 * @returns {boolean} True if backup should be used, false otherwise
 */
function shouldUseBackup() {
  try {
    if (!fs.existsSync(USE_BACKUP_FILE)) {
      return false;
    }
    const content = fs.readFileSync(USE_BACKUP_FILE, 'utf8').trim().toLowerCase();
    return content === 'true';
  } catch (error) {
    console.warn('Warning: Could not read use-backup.txt, defaulting to false:', error.message);
    return false;
  }
}

/**
 * Parse CSV line (handles quoted values)
 */
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

/**
 * Parse CSV text into array of objects
 */
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
        let value = values[index] || '';
        // Convert string booleans to actual booleans
        if (value === 'true') value = true;
        else if (value === 'false') value = false;
        // Convert numeric strings to numbers
        else if (value !== '' && !isNaN(value) && value !== '') {
          const num = parseFloat(value);
          if (!isNaN(num)) value = num;
        }
        // Convert empty strings to null for consistency
        else if (value === '') value = null;
        row[header] = value;
      });
      results.push(row);
    }
  }
  
  return results;
}

/**
 * Read college data from backup CSV file
 * @returns {Promise<Array>} Array of college objects
 */
async function readBackupCSV() {
  try {
    if (!fs.existsSync(BACKUP_CSV_PATH)) {
      throw new Error(`Backup CSV file not found: ${BACKUP_CSV_PATH}`);
    }
    
    console.log(`Reading college data from backup CSV: ${BACKUP_CSV_PATH}`);
    const csvText = fs.readFileSync(BACKUP_CSV_PATH, 'utf8');
    const data = parseCSV(csvText);
    
    console.log(`✓ Successfully loaded ${data.length} colleges from backup CSV`);
    return data;
  } catch (error) {
    console.error('Error reading backup CSV:', error);
    throw error;
  }
}

/**
 * Read college data from backup JSON file
 * @returns {Promise<Array>} Array of college objects
 */
async function readBackupJSON() {
  try {
    if (!fs.existsSync(BACKUP_JSON_PATH)) {
      throw new Error(`Backup JSON file not found: ${BACKUP_JSON_PATH}`);
    }
    
    console.log(`Reading college data from backup JSON: ${BACKUP_JSON_PATH}`);
    const jsonText = fs.readFileSync(BACKUP_JSON_PATH, 'utf8');
    const data = JSON.parse(jsonText);
    
    // Handle both array format and object with data property
    let colleges = Array.isArray(data) ? data : (data.data || data.colleges || []);
    
    if (!Array.isArray(colleges)) {
      throw new Error('Invalid JSON format: expected array or object with data/colleges property');
    }
    
    // Check if colleges need transformation (API format vs internal format)
    // API format has fields like acceptance_rate_pct, sat_25th_percentile
    // Internal format has fields like acceptance_rate, sat_25th_percentile (without _pct suffix)
    const needsTransformation = colleges.length > 0 && colleges[0].acceptance_rate_pct !== undefined;
    
    if (needsTransformation) {
      console.log(`Transforming ${colleges.length} colleges from API format to internal format...`);
      colleges = colleges.map((college, index) => transformApiCollege(college, index));
    }
    
    console.log(`✓ Successfully loaded ${colleges.length} colleges from backup JSON`);
    return colleges;
  } catch (error) {
    console.error('Error reading backup JSON:', error);
    throw error;
  }
}

/**
 * Read college data from backup file (tries JSON first, then CSV)
 * @returns {Promise<Array>} Array of college objects
 */
async function readBackupData() {
  // Try JSON first (as specified by user for use-backup=true case)
  if (fs.existsSync(BACKUP_JSON_PATH)) {
    try {
      return await readBackupJSON();
    } catch (error) {
      console.warn('Failed to read backup JSON, trying CSV:', error.message);
    }
  }
  
  // Fallback to CSV
  return await readBackupCSV();
}

/**
 * Fetch college data from API endpoint
 * @returns {Promise<Array>} Array of transformed college objects
 */
async function fetchCollegeData() {
  // Check if we should force use of backup
  const useBackup = shouldUseBackup();
  
  if (useBackup) {
    console.log('⚠ use-backup.txt is set to true - using backup data instead of API');
    try {
      return await readBackupData();
    } catch (error) {
      console.error('Error reading backup data:', error);
      throw new Error(`Failed to read backup data: ${error.message}`);
    }
  }
  
  // Normal flow: try API first, fallback to backup if API fails
  try {
    console.log('Fetching college data from API...');
    const response = await fetch(API_URL);
    
    if (!response.ok) {
      throw new Error(`API request failed with status ${response.status}`);
    }
    
    const data = await response.json();
    
    if (!data.success || !Array.isArray(data.data)) {
      throw new Error('Invalid API response format');
    }
    
    // Transform API data to internal format
    const transformed = data.data.map((college, index) => transformApiCollege(college, index));
    
    console.log(`✓ Successfully fetched ${transformed.length} colleges from API`);
    return transformed;
  } catch (error) {
    console.error('Error fetching college data from API:', error.message);
    console.log('⚠ API unavailable - falling back to backup data...');
    
    try {
      const backupData = await readBackupData();
      console.log(`✓ Successfully loaded ${backupData.length} colleges from backup (API unavailable)`);
      return backupData;
    } catch (backupError) {
      console.error('Error reading backup data:', backupError);
      throw new Error(`Both API and backup failed. API error: ${error.message}. Backup error: ${backupError.message}`);
    }
  }
}

/**
 * Check the health status of the API endpoint
 * @returns {Promise<{status: string, healthy: boolean}>}
 */
async function checkApiHealth() {
  try {
    const response = await fetch(API_HEALTH_URL);
    
    if (!response.ok) {
      return { status: `Unhealthy (HTTP ${response.status})`, healthy: false };
    }
    
    const data = await response.json();
    
    if (data.status === 'ok') {
      return { status: 'Healthy', healthy: true };
    } else {
      return { status: `Unhealthy (status: ${data.status})`, healthy: false };
    }
  } catch (error) {
    return { status: `Unhealthy (Error: ${error.message})`, healthy: false };
  }
}

module.exports = {
  fetchCollegeData,
  checkApiHealth
};

