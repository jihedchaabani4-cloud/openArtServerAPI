/**
 * Character Domain Configuration
 * process.env reads are isolated to config/ per architecture rule R3.
 */
export const CHARACTER_MAX_DETAIL_MEDIA = Number(process.env.CHARACTER_MAX_DETAIL_MEDIA) || 5;
