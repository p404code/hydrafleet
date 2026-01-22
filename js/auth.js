/**
 * HydraFleet Authentication Module
 * Handles user login, logout, and session management
 */

// Demo user credentials (in production, this would be handled by a backend)
const DEMO_USERS = [
    {
        email: 'admin@hydrafleet.de',
        password: 'admin123',
        name: 'Administrator',
        role: 'admin'
    },
    {
        email: 'user@hydrafleet.de',
        password: 'user123',
        name: 'Max Mustermann',
        role: 'user'
    }
];

// Session storage key
const SESSION_KEY = 'hydrafleet_session';

/**
 * Check if user is authenticated
 */
function isAuthenticated() {
    const session = getSession();
    return session !== null;
}

/**
 * Get current session from storage
 */
function getSession() {
    const sessionData = localStorage.getItem(SESSION_KEY);
    if (!sessionData) return null;

    try {
        const session = JSON.parse(sessionData);
        // Check if session is expired (24 hours)
        if (Date.now() - session.timestamp > 24 * 60 * 60 * 1000) {
            logout();
            return null;
        }
        return session;
    } catch {
        return null;
    }
}

/**
 * Save session to storage
 */
function saveSession(user) {
    const session = {
        email: user.email,
        name: user.name,
        role: user.role,
        timestamp: Date.now()
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

/**
 * Authenticate user with email and password
 */
function authenticate(email, password) {
    const user = DEMO_USERS.find(
        u => u.email.toLowerCase() === email.toLowerCase() && u.password === password
    );

    if (user) {
        saveSession(user);
        return { success: true, user };
    }

    return { success: false, error: 'Ungültige E-Mail oder Passwort' };
}

/**
 * Logout user and clear session
 */
function logout() {
    localStorage.removeItem(SESSION_KEY);
    window.location.href = 'index.html';
}

/**
 * Redirect based on authentication status
 */
function checkAuthAndRedirect() {
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    const isLoginPage = currentPage === 'index.html' || currentPage === '';

    if (isAuthenticated()) {
        // If logged in and on login page, redirect to dashboard
        if (isLoginPage) {
            window.location.href = 'dashboard.html';
        }
    } else {
        // If not logged in and not on login page, redirect to login
        if (!isLoginPage) {
            window.location.href = 'index.html';
        }
    }
}

/**
 * Initialize login form
 */
function initLoginForm() {
    const form = document.getElementById('loginForm');
    const errorMessage = document.getElementById('errorMessage');

    if (!form) return;

    form.addEventListener('submit', function(e) {
        e.preventDefault();

        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;

        // Clear previous error
        errorMessage.textContent = '';

        // Attempt authentication
        const result = authenticate(email, password);

        if (result.success) {
            // Redirect to dashboard
            window.location.href = 'dashboard.html';
        } else {
            // Show error message
            errorMessage.textContent = result.error;

            // Shake animation for error feedback
            form.classList.add('shake');
            setTimeout(() => form.classList.remove('shake'), 500);
        }
    });
}

/**
 * Initialize logout button
 */
function initLogoutButton() {
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', logout);
    }
}

/**
 * Display user info in dashboard
 */
function displayUserInfo() {
    const session = getSession();
    const userNameElement = document.getElementById('userName');

    if (session && userNameElement) {
        userNameElement.textContent = session.name;
    }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
    checkAuthAndRedirect();
    initLoginForm();
    initLogoutButton();
    displayUserInfo();
});
