/**
 * Normalización de nombres y similitud simple (trigramas) para detectar posibles duplicados.
 * La implementación vive en `@pdp/domain` (text.ts) porque el CRM la usa al dar de alta productos
 * especiales; aquí solo se reexporta para no cambiar los imports de la importación del Sheets.
 */
export { normalizeName, similarity, findSimilar, type Candidate } from "@pdp/domain";
