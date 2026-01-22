/**
 * HydraFleet Dashboard Module
 * Handles dashboard functionality and interactions
 */

/**
 * Initialize dashboard navigation
 */
function initNavigation() {
    const navItems = document.querySelectorAll('.nav-item');

    navItems.forEach(item => {
        item.addEventListener('click', function(e) {
            // Remove active class from all items
            navItems.forEach(nav => nav.classList.remove('active'));
            // Add active class to clicked item
            this.classList.add('active');

            // In a real app, this would load different content
            // For now, we just show the visual feedback
        });
    });
}

/**
 * Animate stat numbers on load
 */
function animateStats() {
    const statNumbers = document.querySelectorAll('.stat-number');

    statNumbers.forEach(stat => {
        const finalValue = stat.textContent;
        const isNumber = /^\d+$/.test(finalValue.replace(/[.,\s]/g, '').replace(/L$/, ''));

        if (isNumber) {
            const numericValue = parseInt(finalValue.replace(/[.,\s]/g, '').replace(/L$/, ''));
            const suffix = finalValue.includes('L') ? ' L' : '';
            let current = 0;
            const increment = numericValue / 30;
            const duration = 1000;
            const stepTime = duration / 30;

            stat.textContent = '0' + suffix;

            const counter = setInterval(() => {
                current += increment;
                if (current >= numericValue) {
                    stat.textContent = finalValue;
                    clearInterval(counter);
                } else {
                    stat.textContent = Math.floor(current).toLocaleString('de-DE') + suffix;
                }
            }, stepTime);
        }
    });
}

/**
 * Update activity timestamps (simulated real-time)
 */
function updateTimestamps() {
    // In a real app, this would fetch actual timestamps from a server
    // This is just a placeholder for demonstration
}

/**
 * Initialize mobile sidebar toggle
 */
function initMobileMenu() {
    // Add mobile menu button if on mobile
    if (window.innerWidth <= 768) {
        const sidebar = document.querySelector('.sidebar');
        const header = document.querySelector('.header-left');

        if (header && !document.querySelector('.menu-toggle')) {
            const menuBtn = document.createElement('button');
            menuBtn.className = 'menu-toggle';
            menuBtn.innerHTML = '☰';
            menuBtn.style.cssText = `
                background: none;
                border: none;
                font-size: 24px;
                cursor: pointer;
                margin-right: 16px;
            `;

            menuBtn.addEventListener('click', () => {
                sidebar.classList.toggle('open');
            });

            header.insertBefore(menuBtn, header.firstChild);
        }
    }
}

/**
 * Refresh dashboard data (placeholder for real API calls)
 */
function refreshDashboard() {
    // In a production environment, this would:
    // 1. Fetch updated vehicle data
    // 2. Fetch latest activities
    // 3. Update statistics
    // 4. Refresh map positions

    console.log('Dashboard refreshed at:', new Date().toLocaleTimeString('de-DE'));
}

// Initialize dashboard on load
document.addEventListener('DOMContentLoaded', function() {
    initNavigation();
    animateStats();
    initMobileMenu();

    // Auto-refresh every 5 minutes (in production)
    // setInterval(refreshDashboard, 5 * 60 * 1000);
});

// Handle window resize for mobile menu
window.addEventListener('resize', initMobileMenu);
