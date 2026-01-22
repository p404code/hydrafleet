/**
 * HydraFleet Settlements Dashboard
 * Handles dashboard functionality, data loading, and filtering
 */

// ============================================
// SUPABASE CONFIGURATION
// ============================================

const SUPABASE_URL = 'https://pkxcwfkfaaorwnbdmylg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBreGN3ZmtmYWFvcnduYmRteWxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM3NTE1ODUsImV4cCI6MjA3OTMyNzU4NX0.xBDHKKXA9DFFwcTO18aDH_VHJr9BZyI__lv-L4Apryo';

let supabaseClient = null;

function getSupabase() {
    if (!supabaseClient) {
        if (typeof window.supabase !== 'undefined') {
            supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        } else {
            throw new Error('Supabase library not loaded');
        }
    }
    return supabaseClient;
}

// ============================================
// DATA FETCHING FUNCTIONS
// ============================================

async function fetchSettlements() {
    const client = getSupabase();
    const { data, error } = await client
        .from('settlements')
        .select('*')
        .order('week', { ascending: false });

    if (error) {
        console.error('Error fetching settlements:', error);
        throw error;
    }
    return data || [];
}

async function fetchFilteredSettlements(week = null, driverSearch = '') {
    const client = getSupabase();
    let query = client
        .from('settlements')
        .select('*');

    if (week) {
        query = query.eq('week', week);
    }

    if (driverSearch) {
        query = query.ilike('driver_name', `%${driverSearch}%`);
    }

    query = query.order('week', { ascending: false });

    const { data, error } = await query;

    if (error) {
        console.error('Error fetching filtered settlements:', error);
        throw error;
    }
    return data || [];
}

async function fetchUniqueWeeks() {
    const client = getSupabase();
    const { data, error } = await client
        .from('settlements')
        .select('week')
        .order('week', { ascending: false });

    if (error) {
        console.error('Error fetching weeks:', error);
        throw error;
    }

    const weeks = [...new Set(data.map(item => item.week))];
    return weeks;
}

// ============================================
// DASHBOARD LOGIC
// ============================================

let allSettlements = [];
let filteredSettlements = [];

async function initDashboard() {
    initDarkMode();
    initEventListeners();
    await loadData();
}

function initEventListeners() {
    // Week filter
    const weekFilter = document.getElementById('weekFilter');
    if (weekFilter) {
        weekFilter.addEventListener('change', applyFilters);
    }

    // Driver search with debounce
    let searchTimeout;
    const driverSearch = document.getElementById('driverSearch');
    if (driverSearch) {
        driverSearch.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => applyFilters(), 300);
        });
    }

    // Refresh button
    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', loadData);
    }

    // Dark mode toggle
    const darkModeToggle = document.getElementById('darkModeToggle');
    if (darkModeToggle) {
        darkModeToggle.addEventListener('click', toggleDarkMode);
    }
}

async function loadData() {
    showLoading(true);
    hideError();

    try {
        allSettlements = await fetchSettlements();
        filteredSettlements = allSettlements;

        await populateWeekFilter();
        updateStats(filteredSettlements);
        renderSettlements(filteredSettlements);

        showLoading(false);
    } catch (error) {
        showLoading(false);
        showError('Fehler beim Laden der Daten: ' + error.message);
        console.error('Load error:', error);
    }
}

async function populateWeekFilter() {
    const weekFilter = document.getElementById('weekFilter');
    if (!weekFilter) return;

    const currentValue = weekFilter.value;
    weekFilter.innerHTML = '<option value="">Alle Wochen</option>';

    try {
        const weeks = await fetchUniqueWeeks();
        weeks.forEach(week => {
            const option = document.createElement('option');
            option.value = week;
            option.textContent = `KW ${week}`;
            weekFilter.appendChild(option);
        });

        if (currentValue && weeks.includes(currentValue)) {
            weekFilter.value = currentValue;
        }
    } catch (error) {
        console.error('Error populating weeks:', error);
    }
}

async function applyFilters() {
    const weekFilter = document.getElementById('weekFilter');
    const driverSearchInput = document.getElementById('driverSearch');

    const week = weekFilter ? weekFilter.value : '';
    const driverSearch = driverSearchInput ? driverSearchInput.value.trim() : '';

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

function updateStats(settlements) {
    const uniqueDrivers = new Set(settlements.map(s => s.driver_name || s.driver_id)).size;

    const totalGross = settlements.reduce((sum, s) => sum + (parseFloat(s.gross_revenue) || parseFloat(s.bruttoumsatz) || 0), 0);
    const totalDeduction = settlements.reduce((sum, s) => sum + (parseFloat(s.deduction) || parseFloat(s.abzug) || 0), 0);
    const totalPayout = settlements.reduce((sum, s) => sum + (parseFloat(s.payout) || parseFloat(s.auszahlung) || 0), 0);

    const problems = settlements.filter(s =>
        s.status === 'problem' ||
        s.has_problem === true ||
        s.probleme > 0 ||
        s.problems > 0
    ).length;

    const statDrivers = document.getElementById('statDrivers');
    const statGross = document.getElementById('statGross');
    const statDeduction = document.getElementById('statDeduction');
    const statPayout = document.getElementById('statPayout');
    const statProblems = document.getElementById('statProblems');
    const resultCount = document.getElementById('resultCount');

    if (statDrivers) statDrivers.textContent = uniqueDrivers;
    if (statGross) statGross.textContent = formatCurrency(totalGross);
    if (statDeduction) statDeduction.textContent = formatCurrency(totalDeduction);
    if (statPayout) statPayout.textContent = formatCurrency(totalPayout);
    if (statProblems) statProblems.textContent = problems;
    if (resultCount) resultCount.textContent = `${settlements.length} Einträge`;
}

function renderSettlements(settlements) {
    const tbody = document.getElementById('settlementsBody');
    const noData = document.getElementById('noData');
    const table = document.getElementById('settlementsTable');

    if (!tbody || !table) return;

    if (settlements.length === 0) {
        tbody.innerHTML = '';
        table.style.display = 'none';
        if (noData) noData.style.display = 'block';
        return;
    }

    table.style.display = 'table';
    if (noData) noData.style.display = 'none';

    tbody.innerHTML = settlements.map(settlement => {
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

function formatCurrency(amount) {
    return new Intl.NumberFormat('de-DE', {
        style: 'currency',
        currency: 'EUR'
    }).format(amount);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showLoading(show) {
    const loading = document.getElementById('loadingIndicator');
    if (loading) loading.style.display = show ? 'flex' : 'none';
}

function showError(message) {
    const errorDiv = document.getElementById('errorMessage');
    if (errorDiv) {
        errorDiv.textContent = message;
        errorDiv.style.display = 'block';
    }
}

function hideError() {
    const errorDiv = document.getElementById('errorMessage');
    if (errorDiv) errorDiv.style.display = 'none';
}

function initDarkMode() {
    const isDarkMode = localStorage.getItem('darkMode') === 'true';
    if (isDarkMode) {
        document.body.classList.add('dark-mode');
        updateDarkModeIcon(true);
    }
}

function toggleDarkMode() {
    const isDarkMode = document.body.classList.toggle('dark-mode');
    localStorage.setItem('darkMode', isDarkMode);
    updateDarkModeIcon(isDarkMode);
}

function updateDarkModeIcon(isDarkMode) {
    const icon = document.getElementById('darkModeIcon');
    if (icon) icon.textContent = isDarkMode ? '☀️' : '🌙';
}

// Initialize dashboard when DOM is ready
document.addEventListener('DOMContentLoaded', initDashboard);
