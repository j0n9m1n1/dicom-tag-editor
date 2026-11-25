/**
 * DICOM PS3.15 Annex E (Table E.1-1) PHI / Confidentiality tag metadata,
 * anonymization profile presets (Basic / HIPAA / Teaching), and UTC Date Shifting helpers.
 */

/**
 * Core PHI & identifying DICOM tags mapped to PS3.15 Table E.1-1 Basic Profile action codes:
 *  - 'Z': Replace with zero-length value (or dummy)
 *  - 'D': Replace with non-zero dummy value
 *  - 'X': Remove
 *  - 'U': Replace with new UID
 *  - 'Z/D': Replace with zero-length or dummy
 *  - 'X/Z': Remove or zero-length
 */
export const PHI_TAG_MAP = {
  // Patient Identity
  '00100010': { label: 'PatientName', action: 'Z', category: 'patient', replacement: 'ANONYMOUS' },
  '00100020': { label: 'PatientID', action: 'Z', category: 'patient', replacement: 'ANON-0000' },
  '00100021': { label: 'IssuerOfPatientID', action: 'X', category: 'patient', replacement: '' },
  '00100030': { label: 'PatientBirthDate', action: 'Z', category: 'patient', replacement: '' },
  '00100032': { label: 'PatientBirthTime', action: 'X', category: 'patient', replacement: '' },
  '00100040': { label: 'PatientSex', action: 'Z', category: 'patient', replacement: '' },
  '00101000': { label: 'OtherPatientIDs', action: 'X', category: 'patient', replacement: '' },
  '00101001': { label: 'OtherPatientNames', action: 'X', category: 'patient', replacement: '' },
  '00101005': { label: 'PatientBirthName', action: 'X', category: 'patient', replacement: '' },
  '00101010': { label: 'PatientAge', action: 'X', category: 'patient', replacement: '' },
  '00101020': { label: 'PatientSize', action: 'X', category: 'patient', replacement: '' },
  '00101030': { label: 'PatientWeight', action: 'X', category: 'patient', replacement: '' },
  '00101040': { label: 'PatientAddress', action: 'X', category: 'patient', replacement: '' },
  '00101060': { label: 'PatientMotherBirthName', action: 'X', category: 'patient', replacement: '' },
  '00102154': { label: 'PatientTelephoneNumbers', action: 'X', category: 'patient', replacement: '' },
  '00102160': { label: 'EthnicGroup', action: 'X', category: 'patient', replacement: '' },
  '00102180': { label: 'Occupation', action: 'X', category: 'patient', replacement: '' },
  '001021B0': { label: 'AdditionalPatientHistory', action: 'X', category: 'patient', replacement: '' },
  '00104000': { label: 'PatientComments', action: 'X', category: 'patient', replacement: '' },

  // Institution & Location
  '00080080': { label: 'InstitutionName', action: 'X/Z/D', category: 'institution', replacement: 'ANONYMIZED' },
  '00080081': { label: 'InstitutionAddress', action: 'X', category: 'institution', replacement: '' },
  '00081040': { label: 'InstitutionalDepartmentName', action: 'X', category: 'institution', replacement: '' },
  '00321020': { label: 'ScheduledStudyLocation', action: 'X', category: 'institution', replacement: '' },
  '00380300': { label: 'CurrentPatientLocation', action: 'X', category: 'institution', replacement: '' },

  // Physicians & Operators
  '00080090': { label: 'ReferringPhysicianName', action: 'Z', category: 'staff', replacement: '' },
  '00080092': { label: 'ReferringPhysicianAddress', action: 'X', category: 'staff', replacement: '' },
  '00080094': { label: 'ReferringPhysicianTelephoneNumbers', action: 'X', category: 'staff', replacement: '' },
  '00081048': { label: 'PhysicianOfRecord', action: 'X', category: 'staff', replacement: '' },
  '00081050': { label: 'PerformingPhysicianName', action: 'X', category: 'staff', replacement: '' },
  '00081060': { label: 'NameOfPhysiciansReadingStudy', action: 'X', category: 'staff', replacement: '' },
  '00081070': { label: 'OperatorsName', action: 'X/Z/D', category: 'staff', replacement: '' },
  '0040A123': { label: 'PersonName', action: 'D', category: 'staff', replacement: 'ANONYMOUS' },
  '0040A075': { label: 'VerifyingObserverName', action: 'D', category: 'staff', replacement: 'ANONYMOUS' },

  // Study / Accession / Order Identifiers
  '00080050': { label: 'AccessionNumber', action: 'Z', category: 'order', replacement: '' },
  '00200010': { label: 'StudyID', action: 'Z', category: 'order', replacement: '' },
  '00321060': { label: 'RequestedProcedureDescription', action: 'X', category: 'clinical', replacement: '' },
  '00081030': { label: 'StudyDescription', action: 'X', category: 'clinical', replacement: '' },
  '0008103E': { label: 'SeriesDescription', action: 'X', category: 'clinical', replacement: '' },
  '00181030': { label: 'ProtocolName', action: 'X', category: 'clinical', replacement: '' },
  '00204000': { label: 'ImageComments', action: 'X', category: 'clinical', replacement: '' },

  // Equipment / Network Identifiers
  '00020016': { label: 'SourceApplicationEntityTitle', action: 'X', category: 'device', replacement: '' },
  '00081010': { label: 'StationName', action: 'X/Z/D', category: 'device', replacement: '' },
  '00181000': { label: 'DeviceSerialNumber', action: 'X/Z/D', category: 'device', replacement: '' },
  '00181004': { label: 'PlateID', action: 'X', category: 'device', replacement: '' },
  '00181007': { label: 'CassetteID', action: 'X', category: 'device', replacement: '' },
  '00181008': { label: 'GantryID', action: 'X', category: 'device', replacement: '' },

  // Dates & Times (HIPAA identifiers)
  '00080020': { label: 'StudyDate', action: 'Z', category: 'dates', replacement: '' },
  '00080021': { label: 'SeriesDate', action: 'X/D', category: 'dates', replacement: '' },
  '00080022': { label: 'AcquisitionDate', action: 'X/Z', category: 'dates', replacement: '' },
  '00080023': { label: 'ContentDate', action: 'Z/D', category: 'dates', replacement: '' },
  '0008002A': { label: 'AcquisitionDateTime', action: 'X/Z/D', category: 'dates', replacement: '' },
  '00080030': { label: 'StudyTime', action: 'Z', category: 'dates', replacement: '' },
  '00080031': { label: 'SeriesTime', action: 'X/D', category: 'dates', replacement: '' },
  '00080032': { label: 'AcquisitionTime', action: 'X/Z', category: 'dates', replacement: '' },
  '00080033': { label: 'ContentTime', action: 'Z/D', category: 'dates', replacement: '' },
  '00400244': { label: 'PerformedProcedureStepStartDate', action: 'X', category: 'dates', replacement: '' },
  '00400245': { label: 'PerformedProcedureStepStartTime', action: 'X', category: 'dates', replacement: '' },
  '00400250': { label: 'PerformedProcedureStepEndDate', action: 'X', category: 'dates', replacement: '' },
  '0040A030': { label: 'VerificationDateTime', action: 'D', category: 'dates', replacement: '' },

  // Instance & Study UIDs
  '00020003': { label: 'MediaStorageSOPInstanceUID', action: 'U', category: 'uid', replacement: '' },
  '00080018': { label: 'SOPInstanceUID', action: 'U', category: 'uid', replacement: '' },
  '00081155': { label: 'ReferencedSOPInstanceUID', action: 'U', category: 'uid', replacement: '' },
  '0020000D': { label: 'StudyInstanceUID', action: 'U', category: 'uid', replacement: '' },
  '0020000E': { label: 'SeriesInstanceUID', action: 'U', category: 'uid', replacement: '' },
  '00200052': { label: 'FrameOfReferenceUID', action: 'U', category: 'uid', replacement: '' },
};

/**
 * Editable anonymization preset tag list shown in the Anonymize modal.
 */
export const ANONYMIZE_PRESET_TAGS = [
  { tag: '00100010', label: 'PatientName', replacement: 'ANONYMOUS', profiles: ['basic', 'hipaa', 'teaching'] },
  { tag: '00100020', label: 'PatientID', replacement: 'ANON-0000', profiles: ['basic', 'hipaa', 'teaching'] },
  { tag: '00100030', label: 'PatientBirthDate', replacement: '', profiles: ['basic', 'hipaa', 'teaching'] },
  { tag: '00100040', label: 'PatientSex', replacement: '', profiles: ['basic', 'hipaa'] },
  { tag: '00101010', label: 'PatientAge', replacement: '', profiles: ['basic', 'hipaa'] },
  { tag: '00101040', label: 'PatientAddress', replacement: '', profiles: ['basic', 'hipaa', 'teaching'] },
  { tag: '00104000', label: 'PatientComments', replacement: '', profiles: ['basic', 'hipaa', 'teaching'] },
  { tag: '00080050', label: 'AccessionNumber', replacement: '', profiles: ['basic', 'hipaa', 'teaching'] },
  { tag: '00080080', label: 'InstitutionName', replacement: 'ANONYMIZED', profiles: ['basic', 'hipaa', 'teaching'] },
  { tag: '00080081', label: 'InstitutionAddress', replacement: '', profiles: ['basic', 'hipaa', 'teaching'] },
  { tag: '00080090', label: 'ReferringPhysicianName', replacement: '', profiles: ['basic', 'hipaa', 'teaching'] },
  { tag: '00081050', label: 'PerformingPhysicianName', replacement: '', profiles: ['basic', 'hipaa', 'teaching'] },
  { tag: '00081070', label: 'OperatorsName', replacement: '', profiles: ['basic', 'hipaa', 'teaching'] },
  { tag: '0040A123', label: 'PersonName (SR)', replacement: 'ANONYMOUS', profiles: ['basic', 'hipaa', 'teaching'] },
  { tag: '00081030', label: 'StudyDescription', replacement: '', profiles: ['hipaa'] },
  { tag: '0008103E', label: 'SeriesDescription', replacement: '', profiles: ['hipaa'] },
  { tag: '00181000', label: 'DeviceSerialNumber', replacement: '', profiles: ['basic', 'hipaa'] },
  { tag: '00081010', label: 'StationName', replacement: '', profiles: ['hipaa'] },
];

export const ANONYMIZE_PROFILES = {
  basic: {
    id: 'basic',
    methodText: 'PS3.15 Basic Application Level Confidentiality Profile',
    markDeidentified: true,
    stripPrivate: false,
    regenerateUids: false,
    shiftDates: false,
    dateShiftDays: -365,
  },
  hipaa: {
    id: 'hipaa',
    methodText: 'HIPAA Safe Harbor De-identification (PS3.15 + Date Shift + UID Regen)',
    markDeidentified: true,
    stripPrivate: true,
    regenerateUids: true,
    shiftDates: true,
    dateShiftDays: -365,
  },
  teaching: {
    id: 'teaching',
    methodText: 'Teaching / Research De-identification (Clinical Descriptions Retained)',
    markDeidentified: true,
    stripPrivate: false,
    regenerateUids: true,
    shiftDates: false,
    dateShiftDays: -365,
  },
};

/**
 * Return PS3.15 PHI metadata for a normalized 8-char uppercase hex tag, or null.
 * @param {string} hexTag
 */
export function getPhiTagInfo(hexTag) {
  return PHI_TAG_MAP[String(hexTag || '').toUpperCase()] || null;
}

/**
 * Determine whether a live node is a PHI-bearing attribute (non-deleted, non-sequence).
 * @param {any} node
 */
export function isPhiNode(node) {
  if (!node || node.status === 'deleted' || node.isSequence) return false;
  return Boolean(PHI_TAG_MAP[node.tag]);
}

/**
 * Shift a DICOM DA (YYYYMMDD) or DT (YYYYMMDDHHMMSS.FFFFFF&ZZXX) value by integer days in UTC.
 * Preserves time/fractional seconds/timezone suffix on DT and handles multi-valued backslash strings.
 * Returns the original string unchanged if not a valid parseable date prefix.
 * @param {string} value
 * @param {string} vr
 * @param {number} days
 */
export function shiftDicomDateValue(value, vr, days) {
  if (!value || !Number.isFinite(days) || days === 0) return value;
  const delta = Math.trunc(days);
  if (delta === 0) return value;

  const shiftSingle = (part) => {
    const trimmed = part.trim();
    const m = /^(\d{4})(\d{2})(\d{2})(.*)$/.exec(trimmed);
    if (!m) return part;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const suffix = m[4] || '';
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
      return part;
    }
    dt.setUTCDate(dt.getUTCDate() + delta);
    const ny = String(dt.getUTCFullYear()).padStart(4, '0');
    const nm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const nd = String(dt.getUTCDate()).padStart(2, '0');
    return `${ny}${nm}${nd}${vr === 'DT' ? suffix : ''}`;
  };

  return String(value).split('\\').map(shiftSingle).join('\\');
}
