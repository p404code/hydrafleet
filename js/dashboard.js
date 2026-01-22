/**
 * HydraFleet Settlements Dashboard
 * Handles dashboard functionality, data loading, and filtering
 */

let allSettlements = [];
let filteredSettlements = [];

/**
 * Initialize the dashboard
 */
async function initDashboard() {
    initDarkMode();
    initEventListeners();
    await loadData();
}

/**
 * Initialize event listeners
 */
function initEventListeners() {
    // Week filter
    document.getElementById('weekFilter').addEventListener('change', applyFilters);

    // Driver search with debounce
    let searchTimeout;
    document.getElementById('driverSearch').addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => applyFilters(), 300);
    });

    // Refresh button
    document.getElementById('refreshBtn').addEventListener('click', loadData);

    // Dark mode toggle
    document.getElementById('darkModeToggle').addEventListener('click', toggleDarkMode);
}

/**
 * Load all data from Supabase
 */
async function loadData() {
    showLoading(true);
    hideError();

    try {
        // Fetch settlements
        allSettlements = await fetchSettlements();
        filteredSettlements = allSettlements;

        // Populate week filter
        await populateWeekFilter();

        // Update display
        updateStats(filteredSettlements);
        renderSettlements(filteredSettlements);

        showLoading(false);
    } catch (error) {
        showLoading(false);
        showError('Fehler beim Laden der Daten: ' + error.message);
        console.error('Load error:', error);
    }
}

/**
 * Populate the week filter dropdown
 */
async function populateWeekFilter() {
    const weekFilter = document.getElementById('weekFilter');
    const currentValue = weekFilter.value;

    // Clear existing options except "All"
    weekFilter.innerHTML = '<option value="">Alle Wochen</option>';

    try {
        const weeks = await fetchUniqueWeeks();
        weeks.forEach(week => {
            const option = document.createElement('option');
            option.value = week;
            option.textContent = `KW ${week}`;
            weekFilter.appendChild(option);
        });

        // Restore selection if still valid
        if (currentValue && weeks.includes(currentValue)) {
            weekFilter.value = currentValue;
        }
    } catch (error) {
        console.error('Error populating weeks:', error);
    }
}

/**
 * Apply filters and update display
 */
async function applyFilters() {
    const week = document.getElementById('weekFilter').value;
    const driverSearch = document.getElementById('driverSearch').value.trim();

    showLoading(true);

    try {
        filteredSettlements = await fetchFilteredSettlements(week, driverSearch);
        updateStats(filteredSettlements);
        renderSettlements(filteredSettlements);
        showLoading(false);
    } catch (error) {
        showLoading(false);
        showError('Fehler beim Filtern: ' + error.message);
    }
}

/**
 * Update statistics cards
 */
function updateStats(settlements) {
    // Count unique drivers
    const uniqueDrivers = new Set(settlements.map(s => s.driver_name || s.driver_id)).size;

    // Calculate totals
    const totalGross = settlements.reduce((sum, s) => sum + (parseFloat(s.gross_revenue) || parseFloat(s.bruttoumsatz) || 0), 0);
    const totalDeduction = settlements.reduce((sum, s) => sum + (parseFloat(s.deduction) || parseFloat(s.abzug) || 0), 0);
    const totalPayout = settlements.reduce((sum, s) => sum + (parseFloat(s.payout) || parseFloat(s.auszahlung) || 0), 0);

    // Count problems (assuming there's a status or problem field)
    const problems = settlements.filter(s =>
        s.status === 'problem' ||
        s.has_problem === true ||
        s.probleme > 0 ||
        s.problems > 0
    ).length;

    // Update DOM
    document.getElementById('statDrivers').textContent = uniqueDrivers;
    document.getElementById('statGross').textContent = formatCurrency(totalGross);
    document.getElementById('statDeduction').textContent = formatCurrency(totalDeduction);
    document.getElementById('statPayout').textContent = formatCurrency(totalPayout);
    document.getElementById('statProblems').textContent = problems;

    // Update result count
    document.getElementById('resultCount').textContent = `${settlements.length} Einträge`;
}

/**
 * Render settlements table
 */
function renderSettlements(settlements) {
    const tbody = document.getElementById('settlementsBody');
    const noData = document.getElementById('noData');
    const table = document.getElementById('settlementsTable');

    if (settlements.length === 0) {
        tbody.innerHTML = '';
        table.style.display = 'none';
        noData.style.display = 'block';
        return;
    }

    table.style.display = 'table';
    noData.style.display = 'none';

    tbody.innerHTML = settlements.map(settlement => {
        // Handle different possible field names
        const week = settlement.week || settlement.woche || '-';
        const driver = settlement.driver_name || settlement.fahrer || settlement.driver || '-';
        const gross = parseFloat(settlement.gross_revenue) || parseFloat(settlement.bruttoumsatz) || 0;
        const deduction = parseFloat(settlement.deduction) || parseFloat(settlement.abzug) || 0;
        const payout = parseFloat(settlement.payout) || parseFloat(settlement.auszahlung) || 0;
        const status = getStatus(settlement);

        return `
            <tr>
                <td><span class="week-badge">KW ${week}</span></td>
                <td>${escapeHtml(driver)}</td>
                <td class="amount">${formatCurrency(gross)}</td>
                <td class="amount deduction">${formatCurrency(deduction)}</td>
                <td class="amount payout">${formatCurrency(payout)}</td>
                <td>${status}</td>
            </tr>
        `;
    }).join('');
}

/**
 * Get status badge HTML
 */
function getStatus(settlement) {
    const hasProblem = settlement.status === 'problem' ||
                       settlement.has_problem === true ||
                       settlement.probleme > 0 ||
                       settlement.problems > 0;

    const isPaid = settlement.status === 'paid' ||
                   settlement.paid === true ||
                   settlement.bezahlt === true;

    if (hasProblem) {
        return '<span class="status-badge problem">Problem</span>';
    } else if (isPaid) {
        return '<span class="status-badge paid">Bezahlt</span>';
    } else {
        return '<span class="status-badge pending">Ausstehend</span>';
    }
}

/**
 * Format number as currency (EUR)
 */
function formatCurrency(amount) {
    return new Intl.NumberFormat('de-DE', {
        style: 'currency',
        currency: 'EUR'
    }).format(amount);
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Show/hide loading indicator
 */
function showLoading(show) {
    document.getElementById('loadingIndicator').style.display = show ? 'flex' : 'none';
}

/**
 * Show error message
 */
function showError(message) {
    const errorDiv = document.getElementById('errorMessage');
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
}

/**
 * Hide error message
 */
function hideError() {
    document.getElementById('errorMessage').style.display = 'none';
}

/**
 * Initialize dark mode from localStorage
 */
function initDarkMode() {
    const isDarkMode = localStorage.getItem('darkMode') === 'true';
    if (isDarkMode) {
        document.body.classList.add('dark-mode');
        updateDarkModeIcon(true);
    }
}

/**
 * Toggle dark mode
 */
function toggleDarkMode() {
    const isDarkMode = document.body.classList.toggle('dark-mode');
    localStorage.setItem('darkMode', isDarkMode);
    updateDarkModeIcon(isDarkMode);
}

/**
 * Update dark mode button icon
 */
function updateDarkModeIcon(isDarkMode) {
    const icon = document.getElementById('darkModeIcon');
    icon.textContent = isDarkMode ? '☀️' : '🌙';
}

// Initialize dashboard when DOM is ready
document.addEventListener('DOMContentLoaded', initDashboard);
