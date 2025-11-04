# Personality Development Sessions Website

A modern, mobile-first website for booking 1:1 personality development sessions. Features include payment processing, user data collection, Calendly integration, and comprehensive analytics tracking.

## Features

- **Mobile-First Design**: Optimized for mobile users with responsive design
- **Payment Integration**: Secure payment processing (Stripe/PayPal ready)
- **User Data Collection**: Comprehensive forms for user details and goals
- **Calendly Integration**: Seamless session scheduling
- **Analytics Tracking**: Google Analytics, Facebook Pixel, and custom event tracking
- **Database Storage**: SQLite database for user and session management
- **Admin Dashboard**: View user data and analytics

## Quick Start

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Start the Server**
   ```bash
   npm start
   ```

3. **Visit the Website**
   Open http://localhost:3000 in your browser

## Setup Instructions

### 1. Install Node.js
Make sure you have Node.js 14+ installed on your system.

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Calendly
1. Sign up for a Calendly account
2. Create a new event type for "Personality Development Session"
3. Update the Calendly URL in `script.js`:
   ```javascript
   // Replace 'your-username' with your actual Calendly username
   url: 'https://calendly.com/your-username/personality-session'
   ```

### 4. Configure Razorpay Payment Processing
1. Sign up for Razorpay at https://razorpay.com/
2. Get your Key ID and Key Secret from the dashboard
3. Update the Razorpay configuration in `script.js`:
   ```javascript
   const RAZORPAY_CONFIG = {
       key: 'rzp_test_your_actual_key_id', // Replace with your actual key
       // ... other config
   };
   ```
4. Update the `.env` file with your Razorpay credentials:
   ```
   RAZORPAY_KEY_ID=rzp_test_your_key_id
   RAZORPAY_KEY_SECRET=your_razorpay_secret_key
   ```

### 5. Configure Analytics
Add your tracking IDs to the HTML head section:

```html
<!-- Google Analytics -->
<script async src="https://www.googletagmanager.com/gtag/js?id=GA_MEASUREMENT_ID"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'GA_MEASUREMENT_ID');
</script>

<!-- Facebook Pixel -->
<script>
  !function(f,b,e,v,n,t,s)
  {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};
  if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
  n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];
  s.parentNode.insertBefore(t,s)}(window, document,'script',
  'https://connect.facebook.net/en_US/fbevents.js');
  fbq('init', 'FACEBOOK_PIXEL_ID');
  fbq('track', 'PageView');
</script>
```

## File Structure

```
personality-development/
├── index.html          # Main website page
├── styles.css          # CSS styles
├── script.js          # JavaScript functionality
├── server.js          # Express server
├── package.json        # Dependencies and scripts
├── README.md          # This file
└── personality_sessions.db # SQLite database (created automatically)
```

## API Endpoints

- `GET /` - Serve the main website
- `POST /api/users` - Create or update user data
- `GET /api/users/:email` - Get user by email
- `GET /api/users` - Get all users (admin)
- `POST /api/events` - Track events
- `GET /api/analytics` - Get analytics data
- `POST /api/sessions` - Create session
- `GET /api/users/:userId/sessions` - Get user sessions
- `PUT /api/sessions/:sessionId` - Update session status

## Admin Dashboard

Access the admin dashboard at `/admin` to view:
- User registrations
- Payment status
- Session bookings
- Analytics data
- Event tracking

## Customization

### Changing the Price
Update the price in both `index.html` and `script.js`:
- HTML: Update the price display in the pricing section
- JavaScript: Update the amount in payment processing

### Modifying Services
Edit the services section in `index.html` to match your offerings.

### Styling Changes
All styles are in `styles.css`. The design uses:
- CSS Grid and Flexbox for layouts
- CSS custom properties for colors
- Mobile-first responsive design

## Deployment

### Heroku Deployment
1. Create a Heroku app
2. Add PostgreSQL addon for production database
3. Set environment variables
4. Deploy with Git

### Vercel Deployment
1. Connect your GitHub repository
2. Set build command: `npm install`
3. Set output directory: `.`
4. Deploy

### Traditional Hosting
1. Upload files to your web server
2. Install Node.js on the server
3. Run `npm install`
4. Start with `npm start`

## Database Management

The SQLite database is created automatically. For production, consider using PostgreSQL or MySQL.

### Database Schema

**Users Table:**
- id, email, name, phone, age, profession
- goals, experience, additional_info
- payment_method, payment_amount, payment_status
- session_booked, session_id
- created_at, updated_at

**Events Table:**
- id, user_id, event_name, event_data, timestamp

**Sessions Table:**
- id, user_id, session_date, session_type, status, notes, created_at

## Analytics Events Tracked

- `page_view` - Page visits
- `payment_completed` - Successful payments
- `details_submitted` - User details form submission
- `calendly_loaded` - Calendly widget loaded
- `session_booked` - Session scheduled

## Support

For questions or issues:
1. Check the console for error messages
2. Verify all dependencies are installed
3. Ensure Node.js version is 14+
4. Check database permissions

## License

MIT License - feel free to modify and use for your business.
