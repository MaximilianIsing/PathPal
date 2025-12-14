const fs = require('fs');
const path = require('path');

// Load GPT key from env or local file (same pattern as server.js)
let GPT_API_KEY = process.env.GPT_API_KEY || '';
if (!GPT_API_KEY) {
  try {
    GPT_API_KEY = fs.readFileSync(path.join(__dirname, 'gpt-key.txt'), 'utf8').trim();
  } catch (error) {
    // If there is no key, we will gracefully fall back to a neutral activities score.
    console.warn('rate-system: GPT API key not found; activities will be scored with a default value.');
  }
}

/**
 * Call GPT to rate a student's activities on a 1–10 scale.
 * Returns a number between 1 and 10 (or a neutral default of 5.5 on failure).
 *
 * @param {string} activitiesText - Multiline string describing activities.
 * @returns {Promise<number>}
 */
async function getActivitiesScore(activitiesText) {
  if (!activitiesText || !activitiesText.trim()) {
    return 5.5; // neutral if no activities provided
  }

  if (!GPT_API_KEY) {
    return 5.5;
  }

  const prompt = `
You are an experienced college admissions reader.
You will be given a student's extracurricular activities, formatted as one activity per line.
Rate the overall strength of the student's activities on a scale from 1 to 10, where:
- 1 means very weak activities,
- 5 means average/typical activities,
- 10 means exceptionally strong, highly impressive activities for competitive colleges.

Only respond with a single integer between 1 and 10, no explanation.

Student activities:
${activitiesText}
`.trim();

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GPT_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You are a strict but fair admissions reader. Answer with numbers only when asked for a score.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 10
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('rate-system: GPT API error:', data.error || data);
      return 5.5;
    }

    const raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
    const match = raw.match(/(\d+)/);
    const score = match ? parseInt(match[1], 10) : NaN;

    if (Number.isNaN(score)) {
      return 5.5;
    }

    return Math.min(10, Math.max(1, score));
  } catch (err) {
    console.error('rate-system: error calling GPT:', err);
    return 5.5;
  }
}

/**
 * Compute a relative score for a student based on academics and activities.
 * The score is on a 0–100 scale and is meant to be *relative*, not an official rating.
 *
 * @param {Object} student
 * @param {number|string} [student.gpa]            - GPA on a 0–4 (or 0–5) scale.
 * @param {boolean} [student.weighted=true]        - Whether GPA is weighted.
 * @param {number|string} [student.sat]            - SAT total (400–1600).
 * @param {number|string} [student.act]            - ACT composite (1–36).
 * @param {boolean} [student.testOptional=false]   - Whether student is applying test optional (exclude test scores).
 * @param {Array<{course:string, score:string|number}>} [student.apCourses] - AP courses with scores.
 * @param {string|Array<{hours:string, description:string}>} [student.activities] - Activities as string (legacy) or JSON array.
 * @returns {Promise<number>}                      - Promise resolving to a 0–100 score.
 */
async function rateStudent(student) {
  const {
    gpa,
    weighted = true,
    sat,
    act,
    testOptional = false,
    apCourses = [],
    activities = ''
  } = student || {};

  // Convert activities array to string format for GPT
  let activitiesText = '';
  if (Array.isArray(activities)) {
    // Convert JSON array to multiline string format
    activitiesText = activities
      .filter(a => a && a.description)
      .map(a => {
        const hours = a.hours ? `${a.hours} hrs — ` : '';
        return hours + a.description;
      })
      .join('\n');
  } else if (typeof activities === 'string') {
    // Legacy string format - use as-is
    activitiesText = activities;
  }

  // --- Academic normalization helpers ---

  // GPA normalized to 0–1 (treat weighted GPAs as /5, unweighted as /4)
  const gpaNum = typeof gpa === 'string' ? parseFloat(gpa) : (gpa || 0);
  const gpaMax = weighted ? 5.0 : 4.0;
  const gpaNorm = gpaNum > 0 ? Math.min(1, gpaNum / gpaMax) : 0;

  // Test score normalized to 0–1, using whichever is stronger (SAT or ACT)
  // If testOptional is true, skip test scores entirely (set testNorm to 0)
  // IMPORTANT: Low test scores are heavily penalized using a curve that makes them much worse
  let testNorm = 0;
  
  if (!testOptional) {
    const satNum = typeof sat === 'string' ? parseInt(sat, 10) : (sat || 0);
    const actNum = typeof act === 'string' ? parseInt(act, 10) : (act || 0);

    // If no test scores provided (all empty/0), treat as "Untaken" and assume average SAT score of 800
    const isUntaken = (satNum === 0 || sat === '' || sat === null || sat === undefined) && 
                       (actNum === 0 || act === '' || act === null || act === undefined);

    let satNorm = 0;
    if (isUntaken) {
      // Treat "Untaken" as SAT 800 (average score)
      satNorm = Math.min(1, (800 - 400) / (1600 - 400)); // (800 - 400) / 1200 = 0.333...
    } else if (satNum > 0) {
      // Linear normalization first
      const linearNorm = Math.min(1, (satNum - 400) / (1600 - 400)); // 400–1600
      
      // Apply a curve that heavily penalizes low scores
      // Scores below 1000 get exponentially worse
      // Example: 500 SAT → linearNorm = 0.083, but curved = ~0.01 (almost nothing)
      //          1000 SAT → linearNorm = 0.5, curved = ~0.25 (still penalized)
      //          1400 SAT → linearNorm = 0.83, curved = ~0.75 (slightly penalized)
      //          1600 SAT → linearNorm = 1.0, curved = 1.0 (full credit)
      
      if (satNum < 1000) {
        // Very low scores: apply exponential penalty
        // 500 → ~0.01, 600 → ~0.02, 700 → ~0.04, 800 → ~0.08, 900 → ~0.15
        const below1000Ratio = satNum / 1000; // 0.5 for 500, 0.9 for 900
        satNorm = Math.pow(below1000Ratio, 2.5) * 0.3; // Square root curve, then scale down
      } else if (satNum < 1200) {
        // Low scores: still penalized but less harshly
        // 1000 → ~0.25, 1100 → ~0.35
        const lowRangeNorm = (satNum - 1000) / 200; // 0-1 for 1000-1200 range
        satNorm = 0.25 + (lowRangeNorm * 0.25); // 0.25 to 0.5
      } else if (satNum < 1400) {
        // Moderate scores: slight penalty
        // 1200 → ~0.5, 1300 → ~0.65
        const midRangeNorm = (satNum - 1200) / 200; // 0-1 for 1200-1400 range
        satNorm = 0.5 + (midRangeNorm * 0.25); // 0.5 to 0.75
      } else {
        // High scores: full credit with slight boost
        // 1400 → ~0.75, 1500 → ~0.9, 1600 → 1.0
        const highRangeNorm = (satNum - 1400) / 200; // 0-1 for 1400-1600 range
        satNorm = 0.75 + (highRangeNorm * 0.25); // 0.75 to 1.0
      }
    }

    let actNorm = 0;
    if (!isUntaken && actNum > 0) {
      // Convert ACT to SAT equivalent for consistent curve application
      // Rough conversion: ACT 36 ≈ SAT 1600, ACT 1 ≈ SAT 400
      // Linear: ACT 18 ≈ SAT 1000, ACT 24 ≈ SAT 1200, ACT 30 ≈ SAT 1400
      const actToSat = 400 + ((actNum - 1) / 35) * 1200;
      
      // Apply same curve as SAT
      if (actToSat < 1000) {
        const below1000Ratio = actToSat / 1000;
        actNorm = Math.pow(below1000Ratio, 2.5) * 0.3;
      } else if (actToSat < 1200) {
        const lowRangeNorm = (actToSat - 1000) / 200;
        actNorm = 0.25 + (lowRangeNorm * 0.25);
      } else if (actToSat < 1400) {
        const midRangeNorm = (actToSat - 1200) / 200;
        actNorm = 0.5 + (midRangeNorm * 0.25);
      } else {
        const highRangeNorm = (actToSat - 1400) / 200;
        actNorm = 0.75 + (highRangeNorm * 0.25);
      }
    }

    testNorm = Math.max(satNorm, actNorm);
  }

  // AP rigor: combine count and average score into a 0–1 measure
  const validAps = (apCourses || []).filter(c => c && c.course);
  const apCount = validAps.length;
  let apAvgScore = 0;
  if (validAps.length > 0) {
    const total = validAps.reduce((sum, c) => {
      const s = typeof c.score === 'string' ? parseFloat(c.score) : (c.score || 0);
      return sum + (Number.isFinite(s) ? s : 0);
    }, 0);
    apAvgScore = total / validAps.length;
  }

  const apCountNorm = Math.min(1, apCount / 10);            // cap at 10 APs
  const apScoreNorm = Math.min(1, apAvgScore / 5);          // AP scores out of 5
  const apNorm = validAps.length > 0 ? (0.5 * apCountNorm + 0.5 * apScoreNorm) : 0;

  // Activities via GPT (0–1 after normalization)
  const activitiesScore10 = await getActivitiesScore(activitiesText);
  const activitiesNorm = activitiesScore10 / 10; // 1–10 → 0.1–1.0

  // --- Weighted combination into a 0–100 score ---
  // Weights should sum to 1.0
  // Increased test weight to 40% to properly penalize low scores
  // If test optional, redistribute test weight proportionally to other components
  let WEIGHTS = {
    gpa: 0.30,
    tests: 0.40,  // Increased from 0.30 to 0.40 to heavily penalize low test scores
    ap: 0.15,
    activities: 0.15  // Reduced from 0.20 to 0.15 to make room for higher test weight
  };

  // If test optional, redistribute the 40% test weight to other components
  if (testOptional) {
    const testWeight = WEIGHTS.tests;
    const otherWeight = WEIGHTS.gpa + WEIGHTS.ap + WEIGHTS.activities; // 0.60
    // Redistribute proportionally: each component gets its share of the test weight
    WEIGHTS = {
      gpa: WEIGHTS.gpa + (testWeight * (WEIGHTS.gpa / otherWeight)),
      tests: 0, // No test weight
      ap: WEIGHTS.ap + (testWeight * (WEIGHTS.ap / otherWeight)),
      activities: WEIGHTS.activities + (testWeight * (WEIGHTS.activities / otherWeight))
    };
  }

  const composite =
    WEIGHTS.gpa * gpaNorm +
    WEIGHTS.tests * testNorm +
    WEIGHTS.ap * apNorm +
    WEIGHTS.activities * activitiesNorm;

  // Scale to 0–100 and round
  let score = Math.round(composite * 100);
  
  // Apply additional penalty for very low test scores (below 1000 SAT equivalent)
  // This ensures that even with good GPA/activities, a terrible test score drags you down
  if (!testOptional) {
    const satNum = typeof sat === 'string' ? parseInt(sat, 10) : (sat || 0);
    const actNum = typeof act === 'string' ? parseInt(act, 10) : (act || 0);
    const isUntaken = (satNum === 0 || sat === '' || sat === null || sat === undefined) && 
                       (actNum === 0 || act === '' || act === null || act === undefined);
    
    if (!isUntaken) {
      let testScore = 0;
      if (satNum > 0) {
        testScore = satNum;
      } else if (actNum > 0) {
        // Convert ACT to SAT equivalent
        testScore = 400 + ((actNum - 1) / 35) * 1200;
      }
      
      // Apply severe penalty for scores below 1000
      if (testScore > 0 && testScore < 1000) {
        // Penalty multiplier: 500 SAT = 0.5x, 600 = 0.6x, 700 = 0.7x, 800 = 0.8x, 900 = 0.9x
        const penaltyMultiplier = 0.5 + ((testScore - 400) / 600) * 0.4; // 0.5 to 0.9
        score = Math.round(score * penaltyMultiplier);
      }
    }
  }
  
  return score;
}

/**
 * Compute a relative score for a college based on its data.
 * The score is on a 0–100 scale and is meant to be *relative*, not an official rating.
 * Based on average/prestige indicators from the college's data.
 *
 * @param {Object} college
 * @param {number|string} [college.acceptance_rate]        - Acceptance rate (0-1, lower is more selective/prestigious).
 * @param {number|string} [college.sat_50th_percentile]    - Median SAT score (400-1600, higher is better).
 * @param {number|string} [college.act_50th_percentile]    - Median ACT score (1-36, higher is better).
 * @param {number|string} [college.graduation_rate]        - Graduation rate (0-1, higher is better).
 * @param {number|string} [college.retention_rate]         - Freshman retention rate (0-1, higher is better).
 * @param {number|string} [college.median_earnings_10_years] - Median earnings 10 years after graduation (higher is better).
 * @param {number|string} [college.enrollment]             - Total enrollment (can indicate prestige/size).
 * @param {number|string} [college.student_faculty_ratio]   - Student to faculty ratio (lower is better).
 * @returns {number}                                        - A 0–100 score.
 */
function rateCollege(college) {
  const {
    acceptance_rate,
    sat_50th_percentile,
    act_50th_percentile,
    graduation_rate,
    retention_rate,
    median_earnings_10_years,
    enrollment,
    student_faculty_ratio
  } = college || {};

  // Helper to parse numeric values
  const parseNum = (val) => {
    if (val === null || val === undefined || val === '') return null;
    const num = typeof val === 'string' ? parseFloat(val) : val;
    return Number.isFinite(num) ? num : null;
  };

  // --- Normalization helpers (all to 0–1 scale) ---

  // Acceptance rate: lower is better (more selective/prestigious)
  // Invert: 0.1 (10% acceptance) = 1.0, 0.9 (90% acceptance) = 0.0
  let acceptanceNorm = 0;
  const acceptanceRate = parseNum(acceptance_rate);
  if (acceptanceRate !== null && acceptanceRate >= 0 && acceptanceRate <= 1) {
    // Invert: highly selective (low acceptance) = high score
    acceptanceNorm = 1 - acceptanceRate; // 0.1 → 0.9, 0.9 → 0.1
    // Boost very selective schools (below 20% acceptance)
    if (acceptanceRate < 0.2) {
      acceptanceNorm = Math.min(1, acceptanceNorm * 1.2);
    }
  }

  // Test scores: higher is better, use whichever is available (SAT or ACT)
  const satScore = parseNum(sat_50th_percentile);
  const actScore = parseNum(act_50th_percentile);

  let satNorm = 0;
  if (satScore !== null && satScore >= 400 && satScore <= 1600) {
    satNorm = (satScore - 400) / (1600 - 400); // 400 → 0, 1600 → 1
  }

  let actNorm = 0;
  if (actScore !== null && actScore >= 1 && actScore <= 36) {
    actNorm = (actScore - 1) / (36 - 1); // 1 → 0, 36 → 1
  }

  // Use the higher normalized score (convert ACT to SAT equivalent if needed)
  // Rough conversion: ACT 36 ≈ SAT 1600, ACT 1 ≈ SAT 400
  const testNorm = Math.max(satNorm, actNorm);

  // Graduation rate: higher is better
  let graduationNorm = 0;
  const gradRate = parseNum(graduation_rate);
  if (gradRate !== null && gradRate >= 0 && gradRate <= 1) {
    graduationNorm = gradRate; // Already 0-1
  }

  // Retention rate: higher is better
  let retentionNorm = 0;
  const retRate = parseNum(retention_rate);
  if (retRate !== null && retRate >= 0 && retRate <= 1) {
    retentionNorm = retRate; // Already 0-1
  }

  // Median earnings: higher is better
  // Normalize assuming range of $30k-$150k (typical range)
  let earningsNorm = 0;
  const earnings = parseNum(median_earnings_10_years);
  if (earnings !== null && earnings > 0) {
    const minEarnings = 30000;
    const maxEarnings = 150000;
    earningsNorm = Math.min(1, Math.max(0, (earnings - minEarnings) / (maxEarnings - minEarnings)));
  }

  // Enrollment: moderate size can indicate prestige, but very large can be good too
  // Normalize assuming range of 500-50000
  let enrollmentNorm = 0;
  const enroll = parseNum(enrollment);
  if (enroll !== null && enroll > 0) {
    // Prefer moderate to large (5000-30000 range gets higher score)
    if (enroll >= 5000 && enroll <= 30000) {
      enrollmentNorm = 0.8 + (0.2 * (1 - Math.abs(enroll - 15000) / 15000)); // Peak at 15000
    } else if (enroll > 30000) {
      enrollmentNorm = 0.7; // Very large still good
    } else {
      enrollmentNorm = Math.min(0.6, enroll / 5000); // Smaller schools get lower score
    }
  }

  // Student-faculty ratio: lower is better (more personalized)
  // Normalize: 5:1 = 1.0, 25:1 = 0.0
  let ratioNorm = 0;
  const ratio = parseNum(student_faculty_ratio);
  if (ratio !== null && ratio > 0) {
    // Invert: lower ratio = higher score
    ratioNorm = Math.max(0, Math.min(1, 1 - (ratio - 5) / 20)); // 5 → 1.0, 25 → 0.0
  }

  // --- Weighted combination into a 0–100 score ---
  // Weights should sum to 1.0
  const WEIGHTS = {
    selectivity: 0.30,      // Acceptance rate (inverted)
    testScores: 0.25,       // SAT/ACT scores
    graduation: 0.15,       // Graduation rate
    retention: 0.10,        // Retention rate
    earnings: 0.10,         // Median earnings
    enrollment: 0.05,       // Enrollment size
    facultyRatio: 0.05      // Student-faculty ratio
  };

  const composite =
    WEIGHTS.selectivity * acceptanceNorm +
    WEIGHTS.testScores * testNorm +
    WEIGHTS.graduation * graduationNorm +
    WEIGHTS.retention * retentionNorm +
    WEIGHTS.earnings * earningsNorm +
    WEIGHTS.enrollment * enrollmentNorm +
    WEIGHTS.facultyRatio * ratioNorm;

  // Scale to 0–100 and round
  const score = Math.round(composite * 100);
  return score;
}

/**
 * Calculate admission odds based on student score, college score, and acceptance rate.
 * Uses the delta (difference) between scores and the college's acceptance rate to determine percentage chance.
 * If college test score percentiles are provided, uses z-scores for more nuanced evaluation.
 *
 * @param {number|string} studentScore - Student's rating score (0-100).
 * @param {number|string} collegeScore - College's rating score (0-100).
 * @param {number|string} [acceptanceRate] - College's acceptance rate (0-1, e.g., 0.15 for 15%).
 * @param {Object} [options] - Optional parameters for z-score calculation.
 * @param {number|string} [options.studentSat] - Student's SAT score.
 * @param {number|string} [options.studentAct] - Student's ACT score.
 * @param {number|string} [options.collegeSat25] - College's 25th percentile SAT.
 * @param {number|string} [options.collegeSat50] - College's 50th percentile SAT.
 * @param {number|string} [options.collegeSat75] - College's 75th percentile SAT.
 * @param {number|string} [options.collegeAct25] - College's 25th percentile ACT.
 * @param {number|string} [options.collegeAct50] - College's 50th percentile ACT.
 * @param {number|string} [options.collegeAct75] - College's 75th percentile ACT.
 * @returns {number} - Admission odds as a percentage (0-100).
 */
function getAdmissionOdds(studentScore, collegeScore, acceptanceRate, options = {}) {
  // Parse inputs
  const student = typeof studentScore === 'string' ? parseFloat(studentScore) : (studentScore || 0);
  const college = typeof collegeScore === 'string' ? parseFloat(collegeScore) : (collegeScore || 0);
  const acceptance = typeof acceptanceRate === 'string' ? parseFloat(acceptanceRate) : (acceptanceRate || null);

  // Ensure scores are in valid range
  const studentNorm = Math.max(0, Math.min(100, student));
  const collegeNorm = Math.max(0, Math.min(100, college));

  // Calculate delta (difference)
  const delta = studentNorm - collegeNorm;

  // Base odds when scores are equal - start from the college's acceptance rate if available
  // If no acceptance rate, default to 50%
  let baseOdds = 50;
  if (acceptance !== null && acceptance >= 0 && acceptance <= 1) {
    // Use acceptance rate as base, but adjust based on score delta
    // For example: 15% acceptance rate college = base odds of 15% when student matches college
    baseOdds = acceptance * 100;
  }

  // Calculate odds based on delta
  // Positive delta (student > college) = higher odds
  // Negative delta (student < college) = lower odds
  
  // Use a sigmoid-like curve for smooth transitions
  // Scale: each 10 points of delta = ~15% change in odds
  // Max delta impact: ±50 points = ±75% change (capped appropriately)
  
  const deltaMultiplier = 1.5; // Each point of delta = 1.5% change
  let odds = baseOdds + (delta * deltaMultiplier);

  // Apply sigmoid-like curve for more realistic distribution
  // This makes extreme differences less impactful
  const sigmoidFactor = 0.8; // Smoothing factor
  const normalizedDelta = delta / 50; // Normalize to -1 to 1 range
  const sigmoidDelta = (normalizedDelta / (1 + Math.abs(normalizedDelta) * sigmoidFactor)) * 50;
  odds = baseOdds + (sigmoidDelta * deltaMultiplier);
  
  // Calculate z-score adjustment if college test percentiles are available
  let zScoreAdjustment = 0;
  if (options) {
    const parseNum = (val) => {
      if (val === null || val === undefined || val === '') return null;
      const num = typeof val === 'string' ? parseFloat(val) : val;
      return Number.isFinite(num) && num > 0 ? num : null;
    };

    const studentSat = parseNum(options.studentSat);
    const studentAct = parseNum(options.studentAct);
    const sat25 = parseNum(options.collegeSat25);
    const sat50 = parseNum(options.collegeSat50);
    const sat75 = parseNum(options.collegeSat75);
    const act25 = parseNum(options.collegeAct25);
    const act50 = parseNum(options.collegeAct50);
    const act75 = parseNum(options.collegeAct75);

    // Use SAT if available, otherwise ACT
    if (studentSat && sat25 && sat50 && sat75) {
      // Calculate standard deviation from IQR (interquartile range)
      // For normal distribution: IQR ≈ 1.35 * SD, so SD ≈ IQR / 1.35
      const iqr = sat75 - sat25;
      const sd = iqr / 1.35; // Standard deviation
      const mean = sat50; // Median (50th percentile) as mean estimate

      if (sd > 0) {
        // Calculate z-score: z = (student_score - mean) / SD
        const zScore = (studentSat - mean) / sd;
        
        // Convert z-score to adjustment factor
        // Positive z-score (above average) increases odds, negative decreases
        // Scale: z-score of +1 (1 SD above) = +8% boost, z-score of -1 = -8% penalty
        // Use a diminishing returns curve for extreme z-scores
        zScoreAdjustment = (zScore * 8) / (1 + Math.abs(zScore) * 0.3);
      }
    } else if (studentAct && act25 && act50 && act75) {
      // Same calculation for ACT
      const iqr = act75 - act25;
      const sd = iqr / 1.35;
      const mean = act50;

      if (sd > 0) {
        const zScore = (studentAct - mean) / sd;
        zScoreAdjustment = (zScore * 8) / (1 + Math.abs(zScore) * 0.3);
      }
    }
  }

  // Apply z-score adjustment
  odds = odds + zScoreAdjustment;

  // Give slightly higher odds than calculated, especially for selective schools
  // This makes the system more optimistic
  let optimismBoost = 1.10; // Default 10% boost
  
  if (acceptance !== null && acceptance >= 0 && acceptance <= 1) {
    const acceptancePercent = acceptance * 100;
    
    // Higher boost for more selective schools
    if (acceptancePercent < 10) {
      // Very selective (5% acceptance): 15% boost
      optimismBoost = 1.15;
    } else if (acceptancePercent < 20) {
      // Highly selective (10-20% acceptance): 12% boost
      optimismBoost = 1.12;
    } else if (acceptancePercent < 30) {
      // Selective (20-30% acceptance): 11% boost
      optimismBoost = 1.11;
    }
    // Otherwise use default 10% boost
  }
  
  odds = odds * optimismBoost;

  // If acceptance rate is provided, use it as a constraint
  // The odds should not exceed the acceptance rate by too much, and should scale with it
  if (acceptance !== null && acceptance >= 0 && acceptance <= 1) {
    const acceptancePercent = acceptance * 100;
    
    // Scale the odds relative to the acceptance rate
    // If baseOdds was set from acceptance rate, we've already accounted for it
    // But we should ensure odds don't go too far above/below the acceptance rate based on delta alone
    
    // For highly selective schools (low acceptance), limit how high odds can go
    if (acceptancePercent < 20) {
      // Very selective: odds can go up to 2x the acceptance rate for strong students
      const maxOdds = Math.min(acceptancePercent * 2.5, 95);
      odds = Math.min(odds, maxOdds);
    } else if (acceptancePercent < 50) {
      // Moderately selective: odds can go up to 1.8x the acceptance rate
      const maxOdds = Math.min(acceptancePercent * 1.8, 95);
      odds = Math.min(odds, maxOdds);
    } else {
      // Less selective: odds can go higher, but still cap at reasonable level
      const maxOdds = Math.min(acceptancePercent * 1.5, 95);
      odds = Math.min(odds, maxOdds);
    }
    
    // Ensure odds don't go below a minimum based on acceptance rate
    // Even weak students have some chance at less selective schools
    if (acceptancePercent > 50) {
      const minOdds = Math.max(acceptancePercent * 0.3, 5);
      odds = Math.max(odds, minOdds);
    } else {
      const minOdds = Math.max(acceptancePercent * 0.2, 2);
      odds = Math.max(odds, minOdds);
    }
  }

  // Clamp to reasonable bounds (2% to 98%)
  odds = Math.max(2, Math.min(98, odds));

  // Round to nearest integer
  return Math.round(odds);
}

module.exports = {
  rateStudent,
  rateCollege,
  getAdmissionOdds
};


