// Extension manifest for the Ellucian Experience status-card extension.
// This file is read at build time by the Experience SDK's webpack builder and
// becomes dist/manifest.json, which tells Experience what cards this extension
// provides and how administrators can configure them.
//
// Two card types are declared, but both render the SAME React component
// (src/cards/EllucianStatus.jsx). This is deliberate: Experience's Card
// Management cannot duplicate a custom extension card, so the only way to get
// multiple status cards (each watching a different status page) is to declare
// multiple card types in this manifest. Each type appears in Card Management
// as its own card with its own configuration values and role assignments.
module.exports = {
    name: 'ellucian-status-card',
    publisher: 'Dane Abernathy - Norwich University',
    cards: [{
        // Card 1: pinned to Ellucian's own status page (the component's
        // built-in default URL), so it works with no configuration at all.
        type: 'EllucianStatus',
        source: './src/cards/EllucianStatus',
        title: 'Ellucian System Status',
        displayCardType: 'Ellucian Status',
        description: 'Shows maintenance and system status for Ellucian products',
        // Client configuration renders as text fields in Card Management.
        // Both fields are optional overrides - blank values fall back to
        // defaults inside the component. NOTE: Experience renders these as
        // floating labels that truncate around ~45 characters and the schema
        // has no helper-text/placeholder property, so labels must stay short;
        // usage examples live in readme.md instead. Any URL format is
        // accepted because the component normalizes it (see normalizeBaseUrl
        // in EllucianStatus.jsx).
        configuration: {
            client: [{
                key: 'apiBaseUrl',
                label: 'Status API Base URL',
                type: 'text',
                required: false
            }, {
                key: 'refreshMinutes',
                label: 'Refresh Interval (minutes, 1-60)',
                type: 'text',
                required: false
            }]
        }
    }, {
        // Card 2: the generic version of the same component. Administrators
        // point it at any Atlassian Statuspage-powered status page (Canvas,
        // Zoom, Cloudflare, etc.) via the Status API Base URL field; left
        // blank it also defaults to Ellucian.
        type: 'StatuspageSystemStatus',
        source: './src/cards/EllucianStatus',
        title: 'System Status',
        displayCardType: 'Statuspage System Status',
        description: 'Shows status, incidents, and maintenance from any Statuspage-powered status page (defaults to Ellucian)',
        configuration: {
            client: [{
                key: 'apiBaseUrl',
                label: 'Status API Base URL',
                type: 'text',
                required: false
            }, {
                key: 'refreshMinutes',
                label: 'Refresh Interval (minutes, 1-60)',
                type: 'text',
                required: false
            }]
        }
    }]
    // Deliberately no page/pageRoute: the SDK's generated demo page dumped
    // raw session/user JSON, so it was removed. The cards are informational
    // tiles; the "View full status page" link inside the card handles
    // navigation to the vendor's status site.
};