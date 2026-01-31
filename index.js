const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const nodemailer = require('nodemailer');
const schedule = require('node-schedule');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// File upload setup
const upload = multer({ dest: 'uploads/' });

// Database setup
const db = new sqlite3.Database('./tournament.db', (err) => {
  if (err) {
    console.error('Error opening database', err);
  } else {
    console.log('Database connected');
    initializeDatabase();
  }
});

// Initialize database tables
function initializeDatabase() {
  db.serialize(() => {
    // Teams table
    db.run(`CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      seed INTEGER NOT NULL,
      region TEXT NOT NULL,
      eliminated BOOLEAN DEFAULT 0
    )`);

    // Participants table
    db.run(`CREATE TABLE IF NOT EXISTS participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Team assignments table
    db.run(`CREATE TABLE IF NOT EXISTS team_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      participant_id INTEGER NOT NULL,
      team_id INTEGER NOT NULL,
      is_bonus BOOLEAN DEFAULT 0,
      FOREIGN KEY (participant_id) REFERENCES participants(id),
      FOREIGN KEY (team_id) REFERENCES teams(id)
    )`);

    // Games table
    db.run(`CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round TEXT NOT NULL,
      team1_id INTEGER NOT NULL,
      team2_id INTEGER NOT NULL,
      winner_id INTEGER,
      score1 INTEGER,
      score2 INTEGER,
      completed BOOLEAN DEFAULT 0,
      FOREIGN KEY (team1_id) REFERENCES teams(id),
      FOREIGN KEY (team2_id) REFERENCES teams(id),
      FOREIGN KEY (winner_id) REFERENCES teams(id)
    )`);

    // Scores table
    db.run(`CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      participant_id INTEGER NOT NULL,
      week INTEGER NOT NULL,
      points REAL DEFAULT 0,
      overall_points REAL DEFAULT 0,
      FOREIGN KEY (participant_id) REFERENCES participants(id)
    )`);

    // Settings table
    db.run(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`);

    // Initialize default settings
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('logo_url', '')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('company_name', 'March Madness')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('email_logo_url', '')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('smtp_host', '')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('smtp_port', '587')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('smtp_user', '')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('smtp_pass', '')`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('from_email', '')`);
  });
}

// Email configuration
async function getEmailTransporter() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT key, value FROM settings WHERE key LIKE 'smtp_%' OR key = 'from_email'`, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      
      const settings = {};
      rows.forEach(row => {
        settings[row.key] = row.value;
      });

      if (!settings.smtp_host || !settings.smtp_user || !settings.smtp_pass) {
        resolve(null);
        return;
      }

      const transporter = nodemailer.createTransport({
        host: settings.smtp_host,
        port: parseInt(settings.smtp_port) || 587,
        secure: false,
        auth: {
          user: settings.smtp_user,
          pass: settings.smtp_pass
        }
      });

      resolve({ transporter, fromEmail: settings.from_email || settings.smtp_user });
    });
  });
}

// Get settings
async function getSettings() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT key, value FROM settings`, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      const settings = {};
      rows.forEach(row => {
        settings[row.key] = row.value;
      });
      resolve(settings);
    });
  });
}

// Send welcome email
async function sendWelcomeEmail(participant, teams) {
  try {
    const emailConfig = await getEmailTransporter();
    if (!emailConfig) return;

    const settings = await getSettings();
    const { transporter, fromEmail } = emailConfig;

    const teamsList = teams.map(t => `${t.name} (${t.seed} seed - ${t.region})`).join('<br>');

    const mailOptions = {
      from: fromEmail,
      to: participant.email,
      subject: `Your Team Pack - ${settings.company_name || 'March Madness'} Challenge`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          ${settings.email_logo_url ? `<img src="${settings.email_logo_url}" alt="Logo" style="max-width: 200px; margin: 20px 0;">` : ''}
          <h2>Welcome to the Team Pack Challenge!</h2>
          <p>Hi ${participant.name},</p>
          <p>You're all set! Here are your 4 teams:</p>
          <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
            ${teamsList}
          </div>
          <p>Good luck!</p>
          <p style="margin-top: 30px; color: #666; font-size: 12px;">
            Track your progress and check the leaderboard anytime at the challenge site.
          </p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
  } catch (error) {
    console.error('Error sending welcome email:', error);
  }
}

// Send daily standings email
async function sendDailyStandings() {
  try {
    const emailConfig = await getEmailTransporter();
    if (!emailConfig) return;

    const settings = await getSettings();
    const { transporter, fromEmail } = emailConfig;

    // Get current week
    const currentWeek = await getCurrentWeek();
    
    // Get top 10 participants
    const participants = await new Promise((resolve, reject) => {
      db.all(`
        SELECT p.name, p.email, s.overall_points, s.points as week_points
        FROM participants p
        JOIN scores s ON p.id = s.participant_id
        WHERE s.week = ?
        ORDER BY s.overall_points DESC
        LIMIT 10
      `, [currentWeek], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    if (participants.length === 0) return;

    const standingsHtml = participants.map((p, idx) => 
      `<tr>
        <td>${idx + 1}</td>
        <td>${p.name}</td>
        <td>${p.overall_points.toFixed(1)}</td>
        <td>${p.week_points.toFixed(1)}</td>
      </tr>`
    ).join('');

    // Send to all participants
    const allParticipants = await new Promise((resolve, reject) => {
      db.all(`SELECT name, email FROM participants`, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    for (const participant of allParticipants) {
      const mailOptions = {
        from: fromEmail,
        to: participant.email,
        subject: `Daily Standings - ${settings.company_name || 'March Madness'} Challenge`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            ${settings.email_logo_url ? `<img src="${settings.email_logo_url}" alt="Logo" style="max-width: 200px; margin: 20px 0;">` : ''}
            <h2>Today's Standings</h2>
            <p>Hi ${participant.name},</p>
            <p>Here's where everyone stands:</p>
            <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
              <thead>
                <tr style="background: #1e3a5f; color: white;">
                  <th style="padding: 10px; text-align: left;">Rank</th>
                  <th style="padding: 10px; text-align: left;">Name</th>
                  <th style="padding: 10px; text-align: left;">Overall</th>
                  <th style="padding: 10px; text-align: left;">This Week</th>
                </tr>
              </thead>
              <tbody>
                ${standingsHtml}
              </tbody>
            </table>
            <p>Keep tracking your teams!</p>
          </div>
        `
      };

      await transporter.sendMail(mailOptions);
    }
  } catch (error) {
    console.error('Error sending daily standings:', error);
  }
}

// Send weekly winners email
async function sendWeeklyWinners(week) {
  try {
    const emailConfig = await getEmailTransporter();
    if (!emailConfig) return;

    const settings = await getSettings();
    const { transporter, fromEmail } = emailConfig;

    const winners = await new Promise((resolve, reject) => {
      db.all(`
        SELECT p.name, p.email, s.points
        FROM participants p
        JOIN scores s ON p.id = s.participant_id
        WHERE s.week = ?
        ORDER BY s.points DESC
        LIMIT 3
      `, [week], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    if (winners.length === 0) return;

    const payouts = [50, 25, 10];
    const winnersHtml = winners.map((w, idx) => 
      `<tr>
        <td style="padding: 10px;">${idx + 1}</td>
        <td style="padding: 10px;">${w.name}</td>
        <td style="padding: 10px;">${w.points.toFixed(1)}</td>
        <td style="padding: 10px;">$${payouts[idx]}</td>
      </tr>`
    ).join('');

    // Send to all participants
    const allParticipants = await new Promise((resolve, reject) => {
      db.all(`SELECT name, email FROM participants`, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    for (const participant of allParticipants) {
      const mailOptions = {
        from: fromEmail,
        to: participant.email,
        subject: `Week ${week} Winners - ${settings.company_name || 'March Madness'} Challenge`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            ${settings.email_logo_url ? `<img src="${settings.email_logo_url}" alt="Logo" style="max-width: 200px; margin: 20px 0;">` : ''}
            <h2>Week ${week} Winners!</h2>
            <p>Hi ${participant.name},</p>
            <p>Congratulations to our week ${week} winners:</p>
            <table style="width: 100%; border-collapse: collapse; margin: 20px 0; border: 1px solid #ddd;">
              <thead>
                <tr style="background: #1e3a5f; color: white;">
                  <th style="padding: 10px;">Place</th>
                  <th style="padding: 10px;">Name</th>
                  <th style="padding: 10px;">Points</th>
                  <th style="padding: 10px;">Payout</th>
                </tr>
              </thead>
              <tbody>
                ${winnersHtml}
              </tbody>
            </table>
            <p>Keep playing for the overall championship!</p>
          </div>
        `
      };

      await transporter.sendMail(mailOptions);
    }
  } catch (error) {
    console.error('Error sending weekly winners email:', error);
  }
}

// Helper function to get current week
async function getCurrentWeek() {
  const now = new Date();
  // This is a simplified version - you'd want to set actual tournament dates
  return 1; // Default to week 1
}

// API Routes

// Get settings
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await getSettings();
    // Don't send sensitive email settings to frontend
    delete settings.smtp_host;
    delete settings.smtp_port;
    delete settings.smtp_user;
    delete settings.smtp_pass;
    delete settings.from_email;
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update settings (admin only)
app.post('/api/admin/settings', (req, res) => {
  const updates = req.body;
  const promises = Object.entries(updates).map(([key, value]) => {
    return new Promise((resolve, reject) => {
      db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key, value], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  Promise.all(promises)
    .then(() => res.json({ success: true }))
    .catch(err => res.status(500).json({ error: err.message }));
});

// Upload teams CSV
app.post('/api/admin/upload-teams', upload.single('file'), (req, res) => {
  const filePath = req.file.path;
  const teams = [];

  fs.createReadStream(filePath)
    .pipe(csv())
    .on('data', (row) => {
      teams.push({
        name: row.name || row.team,
        seed: parseInt(row.seed),
        region: row.region
      });
    })
    .on('end', () => {
      // Clear existing teams
      db.run('DELETE FROM teams', (err) => {
        if (err) {
          res.status(500).json({ error: err.message });
          return;
        }

        // Insert new teams
        const stmt = db.prepare('INSERT INTO teams (name, seed, region) VALUES (?, ?, ?)');
        teams.forEach(team => {
          stmt.run(team.name, team.seed, team.region);
        });
        stmt.finalize();

        fs.unlinkSync(filePath);
        res.json({ success: true, count: teams.length });
      });
    })
    .on('error', (error) => {
      res.status(500).json({ error: error.message });
    });
});

// Get all teams
app.get('/api/teams', (req, res) => {
  db.all('SELECT * FROM teams ORDER BY region, seed', (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// Register participant
app.post('/api/register', async (req, res) => {
  const { name, email } = req.body;

  // Check if email already exists
  db.get('SELECT * FROM participants WHERE email = ?', [email], async (err, existingParticipant) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }

    if (existingParticipant) {
      // Return existing teams
      db.all(`
        SELECT t.* FROM teams t
        JOIN team_assignments ta ON t.id = ta.team_id
        WHERE ta.participant_id = ? AND ta.is_bonus = 0
      `, [existingParticipant.id], (err, teams) => {
        if (err) {
          res.status(500).json({ error: err.message });
          return;
        }
        res.json({ 
          participant: existingParticipant, 
          teams,
          message: 'You have already registered. Here are your teams.' 
        });
      });
      return;
    }

    // Create new participant
    db.run('INSERT INTO participants (name, email) VALUES (?, ?)', [name, email], function(err) {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }

      const participantId = this.lastID;

      // Assign teams
      assignTeams(participantId, (err, teams) => {
        if (err) {
          res.status(500).json({ error: err.message });
          return;
        }

        // Initialize scores
        for (let week = 1; week <= 3; week++) {
          db.run('INSERT INTO scores (participant_id, week) VALUES (?, ?)', [participantId, week]);
        }

        // Send welcome email
        sendWelcomeEmail({ id: participantId, name, email }, teams);

        res.json({ 
          participant: { id: participantId, name, email }, 
          teams,
          message: 'Registration successful! Check your email for your team pack.' 
        });
      });
    });
  });
});

// Assign teams to participant
function assignTeams(participantId, callback) {
  // Get all teams
  db.all('SELECT * FROM teams', (err, allTeams) => {
    if (err) {
      callback(err);
      return;
    }

    // Get all existing assignments to ensure uniqueness
    db.all('SELECT team_id, participant_id FROM team_assignments WHERE is_bonus = 0', (err, existingAssignments) => {
      if (err) {
        callback(err);
        return;
      }

      // Group teams by seed ranges
      const tier1 = allTeams.filter(t => t.seed >= 1 && t.seed <= 3);
      const tier2 = allTeams.filter(t => t.seed >= 4 && t.seed <= 6);
      const tier3 = allTeams.filter(t => t.seed >= 7 && t.seed <= 10);
      const tier4 = allTeams.filter(t => t.seed >= 11 && t.seed <= 16);

      let selectedTeams = [];
      let attempts = 0;
      const maxAttempts = 1000;

      while (attempts < maxAttempts) {
        selectedTeams = [];
        
        // Select one from each tier
        selectedTeams.push(tier1[Math.floor(Math.random() * tier1.length)]);
        selectedTeams.push(tier2[Math.floor(Math.random() * tier2.length)]);
        selectedTeams.push(tier3[Math.floor(Math.random() * tier3.length)]);
        selectedTeams.push(tier4[Math.floor(Math.random() * tier4.length)]);

        // Check constraints
        const regions = selectedTeams.map(t => t.region);
        const regionCounts = {};
        regions.forEach(r => regionCounts[r] = (regionCounts[r] || 0) + 1);
        
        // No more than 2 from same region
        if (Object.values(regionCounts).some(count => count > 2)) {
          attempts++;
          continue;
        }

        // Check if combination already exists
        const teamIds = selectedTeams.map(t => t.id).sort();
        const combinationExists = existingAssignments.some(assignment => {
          const existingTeams = existingAssignments
            .filter(a => a.participant_id === assignment.participant_id)
            .map(a => a.team_id)
            .sort();
          return JSON.stringify(teamIds) === JSON.stringify(existingTeams);
        });

        if (!combinationExists) {
          break;
        }

        attempts++;
      }

      // Insert assignments
      const stmt = db.prepare('INSERT INTO team_assignments (participant_id, team_id) VALUES (?, ?)');
      selectedTeams.forEach(team => {
        stmt.run(participantId, team.id);
      });
      stmt.finalize((err) => {
        if (err) {
          callback(err);
        } else {
          callback(null, selectedTeams);
        }
      });
    });
  });
}

// Get participant data
app.get('/api/participant/:id', (req, res) => {
  const participantId = req.params.id;

  db.get('SELECT * FROM participants WHERE id = ?', [participantId], (err, participant) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }

    db.all(`
      SELECT t.*, ta.is_bonus FROM teams t
      JOIN team_assignments ta ON t.id = ta.team_id
      WHERE ta.participant_id = ?
    `, [participantId], (err, teams) => {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }

      db.all('SELECT * FROM scores WHERE participant_id = ?', [participantId], (err, scores) => {
        if (err) {
          res.status(500).json({ error: err.message });
          return;
        }

        res.json({ participant, teams, scores });
      });
    });
  });
});

// Get leaderboard
app.get('/api/leaderboard/:type', (req, res) => {
  const type = req.params.type; // overall, week1, week2, week3

  let query = `
    SELECT p.id, p.name, s.overall_points, s.points as week_points, s.week
    FROM participants p
    JOIN scores s ON p.id = s.participant_id
  `;

  if (type === 'overall') {
    query += ` WHERE s.week = 1 ORDER BY s.overall_points DESC`;
  } else if (type.startsWith('week')) {
    const week = parseInt(type.replace('week', ''));
    query += ` WHERE s.week = ? ORDER BY s.points DESC`;
    
    db.all(query, [week], (err, rows) => {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      res.json(rows);
    });
    return;
  }

  db.all(query, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// Update game score (admin)
app.post('/api/admin/game/:id/score', (req, res) => {
  const gameId = req.params.id;
  const { score1, score2, winnerId } = req.body;

  db.run(`
    UPDATE games 
    SET score1 = ?, score2 = ?, winner_id = ?, completed = 1
    WHERE id = ?
  `, [score1, score2, winnerId, gameId], (err) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }

    // Update eliminated status
    const loserId = winnerId === score1 ? score2 : score1;
    db.run('UPDATE teams SET eliminated = 1 WHERE id = ?', [loserId], (err) => {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }

      // Recalculate all scores
      recalculateScores(() => {
        res.json({ success: true });
      });
    });
  });
});

// Recalculate scores
function recalculateScores(callback) {
  db.all('SELECT * FROM participants', (err, participants) => {
    if (err) {
      callback(err);
      return;
    }

    const pointsByRound = {
      'Round of 64': 1,
      'Round of 32': 2,
      'Sweet 16': 4,
      'Elite 8': 7,
      'Final Four': 12,
      'Championship': 20
    };

    participants.forEach(participant => {
      // Get participant's original teams
      db.all(`
        SELECT t.id, t.seed FROM teams t
        JOIN team_assignments ta ON t.id = ta.team_id
        WHERE ta.participant_id = ? AND ta.is_bonus = 0
      `, [participant.id], (err, teams) => {
        if (err) return;

        const teamIds = teams.map(t => t.id);
        
        // Calculate points for each week
        const weeks = {
          1: ['Round of 64', 'Round of 32'],
          2: ['Sweet 16', 'Elite 8'],
          3: ['Final Four', 'Championship']
        };

        Object.entries(weeks).forEach(([week, rounds]) => {
          let weekPoints = 0;

          rounds.forEach(round => {
            db.all(`
              SELECT g.*, t1.seed as team1_seed, t2.seed as team2_seed
              FROM games g
              JOIN teams t1 ON g.team1_id = t1.id
              JOIN teams t2 ON g.team2_id = t2.id
              WHERE g.round = ? AND g.completed = 1
            `, [round], (err, games) => {
              if (err) return;

              games.forEach(game => {
                if (teamIds.includes(game.winner_id)) {
                  let points = pointsByRound[round];
                  
                  // Calculate upset bonus
                  const winnerSeed = game.winner_id === game.team1_id ? game.team1_seed : game.team2_seed;
                  const loserSeed = game.winner_id === game.team1_id ? game.team2_seed : game.team1_seed;
                  
                  if (winnerSeed > loserSeed) {
                    const bonus = Math.min(loserSeed - winnerSeed, 10);
                    points += bonus;
                  }

                  weekPoints += points;
                }
              });

              // Update week score
              db.run(`
                UPDATE scores 
                SET points = ?,
                    overall_points = (
                      SELECT SUM(points) FROM scores WHERE participant_id = ?
                    )
                WHERE participant_id = ? AND week = ?
              `, [weekPoints, participant.id, participant.id, week]);
            });
          });
        });
      });
    });

    if (callback) callback();
  });
}

// Get upsets (Cinderella teams)
app.get('/api/upsets', (req, res) => {
  db.all(`
    SELECT g.*, 
           t1.name as team1_name, t1.seed as team1_seed,
           t2.name as team2_name, t2.seed as team2_seed,
           tw.name as winner_name, tw.seed as winner_seed
    FROM games g
    JOIN teams t1 ON g.team1_id = t1.id
    JOIN teams t2 ON g.team2_id = t2.id
    JOIN teams tw ON g.winner_id = tw.id
    WHERE g.completed = 1
      AND ((g.winner_id = g.team1_id AND t1.seed > t2.seed)
           OR (g.winner_id = g.team2_id AND t2.seed > t1.seed))
    ORDER BY ABS(t1.seed - t2.seed) DESC
    LIMIT 5
  `, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
