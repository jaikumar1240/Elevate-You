#!/bin/bash

echo "🚀 Setting up Personality Development Sessions Website..."
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 14+ first."
    echo "Visit: https://nodejs.org/"
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 14 ]; then
    echo "❌ Node.js version 14+ is required. Current version: $(node -v)"
    exit 1
fi

echo "✅ Node.js $(node -v) detected"

# Install dependencies
echo "📦 Installing dependencies..."
npm install

if [ $? -eq 0 ]; then
    echo "✅ Dependencies installed successfully"
else
    echo "❌ Failed to install dependencies"
    exit 1
fi

# Create .env file if it doesn't exist
if [ ! -f .env ]; then
    echo "📝 Creating .env file..."
    cat > .env << EOF
# Environment Configuration
NODE_ENV=development
PORT=3000

# Calendly Configuration
CALENDLY_USERNAME=your-username
CALENDLY_EVENT_URL=https://calendly.com/your-username/personality-session

# Razorpay Configuration
RAZORPAY_KEY_ID=rzp_test_your_key_id
RAZORPAY_KEY_SECRET=your_razorpay_secret_key

# Analytics Configuration
GOOGLE_ANALYTICS_ID=GA_MEASUREMENT_ID
FACEBOOK_PIXEL_ID=FACEBOOK_PIXEL_ID

# Database Configuration
DB_PATH=./personality_sessions.db
EOF
    echo "✅ .env file created"
else
    echo "✅ .env file already exists"
fi

echo ""
echo "🎉 Setup completed successfully!"
echo ""
echo "📋 Next steps:"
echo "1. Update the .env file with your actual API keys"
echo "2. Configure your Calendly username in script.js"
echo "3. Start the server with: npm start"
echo "4. Visit http://localhost:3000 to view the website"
echo "5. Visit http://localhost:3000/admin to view the admin dashboard"
echo ""
echo "🔧 Configuration needed:"
echo "- Replace 'your-username' in script.js with your Calendly username"
echo "- Add your Stripe/PayPal keys to .env for payment processing"
echo "- Add your Google Analytics and Facebook Pixel IDs to .env"
echo ""
echo "📚 For more information, see README.md"
