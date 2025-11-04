// Pricing configuration
const PRICING_CONFIG = {
    amount: 89,
    currency: 'INR',
    symbol: '₹'
};

// Initialize the application
document.addEventListener('DOMContentLoaded', function() {
    initializeApp();
    updatePricingDisplay();
    checkRazorpayButton();
});

// Check if Razorpay button loads, show fallback if not
function checkRazorpayButton() {
    setTimeout(() => {
        const razorpayButton = document.querySelector('.razorpay-payment-button');
        const fallbackButton = document.querySelector('.fallback-button');
        
        if (!razorpayButton && fallbackButton) {
            fallbackButton.style.display = 'block';
            console.log('Razorpay button not loaded, showing fallback');
        }
    }, 3000); // Wait 3 seconds for Razorpay to load
}

// Update pricing display throughout the page
function updatePricingDisplay() {
    // Update hero section stat
    const heroStat = document.querySelector('.stat-number');
    if (heroStat && heroStat.textContent.includes('₹')) {
        heroStat.textContent = `${PRICING_CONFIG.symbol}${PRICING_CONFIG.amount}`;
    }
    
    // Update pricing section amount
    const priceAmount = document.querySelector('.price-display .amount');
    if (priceAmount) {
        priceAmount.textContent = PRICING_CONFIG.amount;
    }
}

// Initialize app functionality
function initializeApp() {
    // Mobile menu toggle
    const hamburger = document.querySelector('.hamburger');
    const navMenu = document.querySelector('.nav-menu');
    
    if (hamburger && navMenu) {
        hamburger.addEventListener('click', function() {
            navMenu.classList.toggle('active');
            hamburger.classList.toggle('active');
        });
    }

    // Smooth scrolling for navigation links
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            const targetId = this.getAttribute('href');
            const targetSection = document.querySelector(targetId);
            
            if (targetSection) {
                const elementPosition = targetSection.getBoundingClientRect().top;
                const offsetPosition = elementPosition + window.pageYOffset - 100;
                
                window.scrollTo({
                    top: offsetPosition,
                    behavior: 'smooth'
                });
            }
        });
    });
}

// Scroll to testimonials section
function scrollToTestimonials() {
    const testimonialsSection = document.getElementById('testimonials');
    if (testimonialsSection) {
        const elementPosition = testimonialsSection.getBoundingClientRect().top;
        const offsetPosition = elementPosition + window.pageYOffset - 100;
        
        window.scrollTo({
            top: offsetPosition,
            behavior: 'smooth'
        });
    }
}

// Export functions for global access
window.scrollToTestimonials = scrollToTestimonials;