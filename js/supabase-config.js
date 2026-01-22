/**
 * Supabase Configuration for HydraFleet
 *
 * WICHTIG: Ersetze SUPABASE_ANON_KEY mit deinem echten Anon Key!
 * Du findest ihn in deinem Supabase Dashboard unter:
 * Settings > API > Project API keys > anon (public)
 */

const SUPABASE_URL = 'https://pkxcwfkfaaorwnbdmylg.supabase.co';
const SUPABASE_ANON_KEY = 'DEIN_SUPABASE_ANON_KEY_HIER'; // <-- Hier deinen Key einfügen!

// Initialize Supabase client
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * Fetch all settlements from Supabase
 */
async function fetchSettlements() {
    const { data, error } = await supabase
        .from('settlements')
        .select('*')
        .order('week', { ascending: false });

    if (error) {
        console.error('Error fetching settlements:', error);
        throw error;
    }

    return data || [];
}

/**
 * Fetch settlements filtered by week
 */
async function fetchSettlementsByWeek(week) {
    const { data, error } = await supabase
        .from('settlements')
        .select('*')
        .eq('week', week)
        .order('driver_name', { ascending: true });

    if (error) {
        console.error('Error fetching settlements by week:', error);
        throw error;
    }

    return data || [];
}

/**
 * Search settlements by driver name
 */
async function searchSettlementsByDriver(searchTerm) {
    const { data, error } = await supabase
        .from('settlements')
        .select('*')
        .ilike('driver_name', `%${searchTerm}%`)
        .order('week', { ascending: false });

    if (error) {
        console.error('Error searching settlements:', error);
        throw error;
    }

    return data || [];
}

/**
 * Fetch settlements with combined filters
 */
async function fetchFilteredSettlements(week = null, driverSearch = '') {
    let query = supabase
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

/**
 * Get unique weeks from settlements
 */
async function fetchUniqueWeeks() {
    const { data, error } = await supabase
        .from('settlements')
        .select('week')
        .order('week', { ascending: false });

    if (error) {
        console.error('Error fetching weeks:', error);
        throw error;
    }

    // Get unique weeks
    const weeks = [...new Set(data.map(item => item.week))];
    return weeks;
}
