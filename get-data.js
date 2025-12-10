/**
 * Fetches college data from the API endpoint
 * Transforms the API response to match the expected format
 */

const API_URL = 'https://path-pal-college-scanner.onrender.com/getdata?key=23176427708775045798948882391414';
const API_HEALTH_URL = 'https://path-pal-college-scanner.onrender.com/health';

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
 * Fetch college data from API endpoint
 * @returns {Promise<Array>} Array of transformed college objects
 */
async function fetchCollegeData() {
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
    console.error('Error fetching college data from API:', error);
    throw error;
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

