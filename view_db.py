#!/usr/bin/env python3
"""
Database Viewer for Personality Sessions
This script helps you view and manage the SQLite database
"""

import sqlite3
import json
from datetime import datetime

def connect_db():
    """Connect to the SQLite database"""
    return sqlite3.connect('personality_sessions.db')

def view_users():
    """View all users in the database"""
    conn = connect_db()
    cursor = conn.cursor()
    
    print("=" * 80)
    print("USERS TABLE")
    print("=" * 80)
    
    cursor.execute("SELECT COUNT(*) FROM users")
    count = cursor.fetchone()[0]
    print(f"Total Users: {count}")
    
    if count > 0:
        cursor.execute("""
            SELECT id, name, email, phone, goals, payment_status, 
                   payment_amount, created_at 
            FROM users 
            ORDER BY created_at DESC
        """)
        
        users = cursor.fetchall()
        
        for user in users:
            print(f"\nID: {user[0]}")
            print(f"Name: {user[1]}")
            print(f"Email: {user[2]}")
            print(f"Phone: {user[3]}")
            print(f"Goals: {user[4]}")
            print(f"Payment Status: {user[5]}")
            print(f"Amount: ₹{user[6] if user[6] else 0}")
            print(f"Created: {user[7]}")
            print("-" * 40)
    else:
        print("No users found in database.")
    
    conn.close()

def view_events():
    """View all events in the database"""
    conn = connect_db()
    cursor = conn.cursor()
    
    print("\n" + "=" * 80)
    print("EVENTS TABLE")
    print("=" * 80)
    
    cursor.execute("SELECT COUNT(*) FROM events")
    count = cursor.fetchone()[0]
    print(f"Total Events: {count}")
    
    if count > 0:
        cursor.execute("""
            SELECT e.id, e.event_name, e.event_data, e.timestamp, u.name, u.email
            FROM events e
            LEFT JOIN users u ON e.user_id = u.id
            ORDER BY e.timestamp DESC
        """)
        
        events = cursor.fetchall()
        
        for event in events:
            print(f"\nEvent ID: {event[0]}")
            print(f"Event: {event[1]}")
            print(f"Data: {event[2]}")
            print(f"Timestamp: {event[3]}")
            print(f"User: {event[4]} ({event[5]})")
            print("-" * 40)
    else:
        print("No events found in database.")
    
    conn.close()

def view_sessions():
    """View all sessions in the database"""
    conn = connect_db()
    cursor = conn.cursor()
    
    print("\n" + "=" * 80)
    print("SESSIONS TABLE")
    print("=" * 80)
    
    cursor.execute("SELECT COUNT(*) FROM sessions")
    count = cursor.fetchone()[0]
    print(f"Total Sessions: {count}")
    
    if count > 0:
        cursor.execute("""
            SELECT s.id, s.session_date, s.session_type, s.status, s.notes,
                   s.created_at, u.name, u.email
            FROM sessions s
            LEFT JOIN users u ON s.user_id = u.id
            ORDER BY s.session_date DESC
        """)
        
        sessions = cursor.fetchall()
        
        for session in sessions:
            print(f"\nSession ID: {session[0]}")
            print(f"Date: {session[1]}")
            print(f"Type: {session[2]}")
            print(f"Status: {session[3]}")
            print(f"Notes: {session[4]}")
            print(f"Created: {session[5]}")
            print(f"User: {session[6]} ({session[7]})")
            print("-" * 40)
    else:
        print("No sessions found in database.")
    
    conn.close()

# Configuration
SESSION_AMOUNT = 89  # Change this value to update price everywhere

def add_sample_data():
    """Add sample data for testing"""
    conn = connect_db()
    cursor = conn.cursor()
    
    # Add sample user
    cursor.execute("""
        INSERT INTO users (name, email, phone, goals, payment_status, payment_amount)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (
        "John Doe",
        "john@example.com", 
        "9876543210",
        "communication,confidence",
        "completed",
        SESSION_AMOUNT
    ))
    
    user_id = cursor.lastrowid
    
    # Add sample event
    cursor.execute("""
        INSERT INTO events (user_id, event_name, event_data)
        VALUES (?, ?, ?)
    """, (
        user_id,
        "booking_completed",
        f'{{"goals": ["communication", "confidence"], "amount": {SESSION_AMOUNT}}}'
    ))
    
    # Add sample session
    cursor.execute("""
        INSERT INTO sessions (user_id, session_date, session_type, status)
        VALUES (?, ?, ?, ?)
    """, (
        user_id,
        "2024-01-15 10:00:00",
        "personality_development",
        "scheduled"
    ))
    
    conn.commit()
    conn.close()
    
    print("Sample data added successfully!")

def main():
    """Main function"""
    print("Personality Sessions Database Viewer")
    print("=" * 50)
    
    while True:
        print("\nOptions:")
        print("1. View Users")
        print("2. View Events") 
        print("3. View Sessions")
        print("4. View All Data")
        print("5. Add Sample Data")
        print("6. Exit")
        
        choice = input("\nEnter your choice (1-6): ").strip()
        
        if choice == "1":
            view_users()
        elif choice == "2":
            view_events()
        elif choice == "3":
            view_sessions()
        elif choice == "4":
            view_users()
            view_events()
            view_sessions()
        elif choice == "5":
            add_sample_data()
        elif choice == "6":
            print("Goodbye!")
            break
        else:
            print("Invalid choice. Please try again.")

if __name__ == "__main__":
    main()
