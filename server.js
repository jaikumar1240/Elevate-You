const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));

// Initialize SQLite database
const db = new sqlite3.Database('./personality_sessions.db', (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to SQLite database');
        initializeDatabase();
    }
});

// Initialize database tables
function initializeDatabase() {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        age INTEGER,
        profession TEXT,
        goals TEXT,
        experience TEXT,
        additional_info TEXT,
        payment_method TEXT,
        payment_amount REAL,
        payment_status TEXT DEFAULT 'pending',
        payment_id TEXT,
        order_id TEXT,
        signature TEXT,
        session_booked BOOLEAN DEFAULT 0,
        session_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Events tracking table
    db.run(`CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        event_name TEXT NOT NULL,
        event_data TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
    )`);

    // Sessions table
    db.run(`CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        session_date DATETIME,
        session_type TEXT DEFAULT 'personality_development',
        status TEXT DEFAULT 'scheduled',
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
    )`);

    console.log('Database tables initialized');
}

// Routes

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve the admin dashboard
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Create or update user
app.post('/api/users', (req, res) => {
    const {
        email,
        name,
        phone,
        age,
        profession,
        goals,
        experience,
        additionalInfo,
        paymentMethod,
        paymentAmount,
        paymentStatus,
        sessionBooked,
        sessionId
    } = req.body;

    const goalsString = Array.isArray(goals) ? goals.join(',') : goals;

    // Check if user exists
    db.get('SELECT id FROM users WHERE email = ?', [email], (err, row) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Database error' });
        }

        if (row) {
            // Update existing user
            db.run(
                `UPDATE users SET 
                    name = ?, phone = ?, age = ?, profession = ?, goals = ?, 
                    experience = ?, additional_info = ?, payment_method = ?, 
                    payment_amount = ?, payment_status = ?, session_booked = ?, 
                    session_id = ?, updated_at = CURRENT_TIMESTAMP 
                WHERE email = ?`,
                [
                    name, phone, age, profession, goalsString, experience,
                    additionalInfo, paymentMethod, paymentAmount, paymentStatus,
                    sessionBooked ? 1 : 0, sessionId, email
                ],
                function(err) {
                    if (err) {
                        console.error('Update error:', err);
                        return res.status(500).json({ error: 'Update failed' });
                    }
                    res.json({ 
                        success: true, 
                        message: 'User updated successfully',
                        userId: row.id 
                    });
                }
            );
        } else {
            // Create new user
            db.run(
                `INSERT INTO users (
                    email, name, phone, age, profession, goals, experience, 
                    additional_info, payment_method, payment_amount, payment_status,
                    session_booked, session_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    email, name, phone, age, profession, goalsString, experience,
                    additionalInfo, paymentMethod, paymentAmount, paymentStatus || 'pending',
                    sessionBooked ? 1 : 0, sessionId
                ],
                function(err) {
                    if (err) {
                        console.error('Insert error:', err);
                        return res.status(500).json({ error: 'User creation failed' });
                    }
                    res.json({ 
                        success: true, 
                        message: 'User created successfully',
                        userId: this.lastID 
                    });
                }
            );
        }
    });
});

// Track events
app.post('/api/events', (req, res) => {
    const { userId, eventName, eventData } = req.body;

    db.run(
        'INSERT INTO events (user_id, event_name, event_data) VALUES (?, ?, ?)',
        [userId, eventName, JSON.stringify(eventData)],
        function(err) {
            if (err) {
                console.error('Event tracking error:', err);
                return res.status(500).json({ error: 'Event tracking failed' });
            }
            res.json({ success: true, message: 'Event tracked successfully' });
        }
    );
});

// Get user by email
app.get('/api/users/:email', (req, res) => {
    const email = req.params.email;

    db.get(
        'SELECT * FROM users WHERE email = ?',
        [email],
        (err, row) => {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ error: 'Database error' });
            }
            if (row) {
                // Parse goals back to array
                row.goals = row.goals ? row.goals.split(',') : [];
                res.json(row);
            } else {
                res.status(404).json({ error: 'User not found' });
            }
        }
    );
});

// Get all users (admin endpoint)
app.get('/api/users', (req, res) => {
    db.all(
        'SELECT * FROM users ORDER BY created_at DESC',
        [],
        (err, rows) => {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ error: 'Database error' });
            }
            
            // Parse goals for each user
            const users = rows.map(row => ({
                ...row,
                goals: row.goals ? row.goals.split(',') : []
            }));
            
            res.json(users);
        }
    );
});

// Get analytics data
app.get('/api/analytics', (req, res) => {
    const queries = {
        totalUsers: 'SELECT COUNT(*) as count FROM users',
        paidUsers: 'SELECT COUNT(*) as count FROM users WHERE payment_status = "completed"',
        bookedSessions: 'SELECT COUNT(*) as count FROM users WHERE session_booked = 1',
        recentUsers: 'SELECT COUNT(*) as count FROM users WHERE created_at >= datetime("now", "-7 days")',
        eventsByType: 'SELECT event_name, COUNT(*) as count FROM events GROUP BY event_name',
        usersByExperience: 'SELECT experience, COUNT(*) as count FROM users WHERE experience IS NOT NULL GROUP BY experience',
        usersByGoals: 'SELECT goals, COUNT(*) as count FROM users WHERE goals IS NOT NULL GROUP BY goals'
    };

    const results = {};
    let completedQueries = 0;
    const totalQueries = Object.keys(queries).length;

    Object.keys(queries).forEach(key => {
        db.all(queries[key], [], (err, rows) => {
            if (err) {
                console.error(`Query error for ${key}:`, err);
                results[key] = { error: 'Query failed' };
            } else {
                results[key] = rows;
            }
            
            completedQueries++;
            if (completedQueries === totalQueries) {
                res.json(results);
            }
        });
    });
});

// Create session
app.post('/api/sessions', (req, res) => {
    const { userId, sessionDate, sessionType, notes } = req.body;

    db.run(
        'INSERT INTO sessions (user_id, session_date, session_type, notes) VALUES (?, ?, ?, ?)',
        [userId, sessionDate, sessionType || 'personality_development', notes],
        function(err) {
            if (err) {
                console.error('Session creation error:', err);
                return res.status(500).json({ error: 'Session creation failed' });
            }
            res.json({ 
                success: true, 
                message: 'Session created successfully',
                sessionId: this.lastID 
            });
        }
    );
});

// Get sessions for a user
app.get('/api/users/:userId/sessions', (req, res) => {
    const userId = req.params.userId;

    db.all(
        'SELECT * FROM sessions WHERE user_id = ? ORDER BY session_date DESC',
        [userId],
        (err, rows) => {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ error: 'Database error' });
            }
            res.json(rows);
        }
    );
});

// Update session status
app.put('/api/sessions/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    const { status, notes } = req.body;

    db.run(
        'UPDATE sessions SET status = ?, notes = ? WHERE id = ?',
        [status, notes, sessionId],
        function(err) {
            if (err) {
                console.error('Session update error:', err);
                return res.status(500).json({ error: 'Session update failed' });
            }
            res.json({ success: true, message: 'Session updated successfully' });
        }
    );
});


// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        database: 'connected'
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Visit http://localhost:${PORT} to view the website`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down server...');
    db.close((err) => {
        if (err) {
            console.error('Error closing database:', err.message);
        } else {
            console.log('Database connection closed');
        }
        process.exit(0);
    });
});

module.exports = app;
