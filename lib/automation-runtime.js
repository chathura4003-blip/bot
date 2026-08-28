'use strict';

const db = require('./db');

function normalizeTarget(value, defaultSuffix) {
    if (!value) return null;
    let str = String(value).trim();
    if (str.includes('@')) return str;
    const clean = str.replace(/[^0-9]/g, '');
    if (!clean) return null;
    return `${clean}${defaultSuffix || '@s.whatsapp.net'}`;
}

function matchesRule(message, rule) {
    const trigger = String(rule?.trigger || '');
    if (!trigger) return false;

    const source = String(message || '');
    const isCaseSensitive = Boolean(rule.caseSensitive);
    
    const haystack = isCaseSensitive ? source : source.toLowerCase();
    const needle = isCaseSensitive ? trigger : trigger.toLowerCase();

    switch (rule.matchType) {
        case 'regex':
            try {
                const regex = new RegExp(trigger, isCaseSensitive ? '' : 'i');
                return regex.test(source);
            } catch {
                return false;
            }
        case 'word': {
            // Match whole words only using word boundaries
            try {
                const escapedNeedle = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(`\\b${escapedNeedle}\\b`, isCaseSensitive ? '' : 'i');
                return regex.test(source);
            } catch {
                return false;
            }
        }
        case 'contains':
            return haystack.includes(needle);
        case 'startsWith':
            return haystack.startsWith(needle);
        case 'endsWith':
            return haystack.endsWith(needle);
        case 'exact':
        default:
            return haystack.trim() === needle.trim();
    }
}

function findAutoReply(message, options = {}) {
    const {
        isGroupMessage = false,
    } = options;

    const rules = db.listAutoReply();
    return rules.find((rule) => {
        if (!rule || rule.enabled === false) return false;
        const groupsOnly = Boolean(rule.groupsOnly) && !rule.pmOnly;
        const pmOnly = Boolean(rule.pmOnly) && !rule.groupsOnly;
        if (groupsOnly && !isGroupMessage) return false;
        if (pmOnly && isGroupMessage) return false;
        return matchesRule(message, rule);
    }) || null;
}

module.exports = {
    normalizeTarget,
    findAutoReply
};
