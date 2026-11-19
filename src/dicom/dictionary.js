/**
 * DICOM PS3.6 Core Standard Data Element Dictionary & Transfer Syntax Registry.
 * Keys are normalized 8-char uppercase hex strings: "GGGGEEEE".
 */

export const TRANSFER_SYNTAXES = {
  '1.2.840.10008.1.2': {
    name: 'Implicit VR Little Endian',
    explicit: false, littleEndian: true, compressed: false, deflated: false,
  },
  '1.2.840.10008.1.2.1': {
    name: 'Explicit VR Little Endian',
    explicit: true, littleEndian: true, compressed: false, deflated: false,
  },
  '1.2.840.10008.1.2.1.99': {
    name: 'Deflated Explicit VR Little Endian',
    explicit: true, littleEndian: true, compressed: false, deflated: true,
  },
  '1.2.840.10008.1.2.2': {
    name: 'Explicit VR Big Endian (Retired)',
    explicit: true, littleEndian: false, compressed: false, deflated: false,
  },
  '1.2.840.10008.1.2.4.50': {
    name: 'JPEG Baseline (Process 1)',
    explicit: true, littleEndian: true, compressed: true, codec: 'jpeg-baseline',
  },
  '1.2.840.10008.1.2.4.51': {
    name: 'JPEG Extended (Process 2 & 4)',
    explicit: true, littleEndian: true, compressed: true, codec: 'jpeg-baseline',
  },
  '1.2.840.10008.1.2.4.57': {
    name: 'JPEG Lossless, Non-Hierarchical (Process 14)',
    explicit: true, littleEndian: true, compressed: true, codec: 'jpeg-lossless',
  },
  '1.2.840.10008.1.2.4.70': {
    name: 'JPEG Lossless, Non-Hierarchical, First-Order Prediction',
    explicit: true, littleEndian: true, compressed: true, codec: 'jpeg-lossless',
  },
  '1.2.840.10008.1.2.4.80': {
    name: 'JPEG-LS Lossless Image Compression',
    explicit: true, littleEndian: true, compressed: true, codec: 'jpeg-ls',
  },
  '1.2.840.10008.1.2.4.81': {
    name: 'JPEG-LS Lossy (Near-Lossless) Image Compression',
    explicit: true, littleEndian: true, compressed: true, codec: 'jpeg-ls',
  },
  '1.2.840.10008.1.2.4.90': {
    name: 'JPEG 2000 Image Compression (Lossless Only)',
    explicit: true, littleEndian: true, compressed: true, codec: 'jpeg2000',
  },
  '1.2.840.10008.1.2.4.91': {
    name: 'JPEG 2000 Image Compression',
    explicit: true, littleEndian: true, compressed: true, codec: 'jpeg2000',
  },
  '1.2.840.10008.1.2.4.201': {
    name: 'High-Throughput JPEG 2000 (Lossless Only)',
    explicit: true, littleEndian: true, compressed: true, codec: 'htj2k',
  },
  '1.2.840.10008.1.2.4.203': {
    name: 'High-Throughput JPEG 2000',
    explicit: true, littleEndian: true, compressed: true, codec: 'htj2k',
  },
  '1.2.840.10008.1.2.5': {
    name: 'RLE Lossless',
    explicit: true, littleEndian: true, compressed: true, codec: 'rle',
  },
};

export function getTransferSyntaxInfo(uid) {
  const clean = (uid || '').replace(/\0+$/, '').trim();
  return TRANSFER_SYNTAXES[clean] || {
    name: clean ? `Unknown (${clean})` : 'Implicit VR Little Endian (Default)',
    explicit: clean !== '',
    littleEndian: true,
    compressed: false,
    deflated: false,
  };
}

export const KNOWN_SOP_UIDS = {
  '1.2.840.10008.1.1': 'Verification SOP Class',
  '1.2.840.10008.5.1.4.1.1.1': 'Computed Radiography (CR) Image Storage',
  '1.2.840.10008.5.1.4.1.1.1.1': 'Digital X-Ray (DX) Image Storage - For Presentation',
  '1.2.840.10008.5.1.4.1.1.1.1.1': 'Digital X-Ray (DX) Image Storage - For Processing',
  '1.2.840.10008.5.1.4.1.1.1.2': 'Digital Mammography (MG) X-Ray Image Storage - For Presentation',
  '1.2.840.10008.5.1.4.1.1.1.2.1': 'Digital Mammography (MG) X-Ray Image Storage - For Processing',
  '1.2.840.10008.5.1.4.1.1.2': 'CT Image Storage',
  '1.2.840.10008.5.1.4.1.1.2.1': 'Enhanced CT Image Storage',
  '1.2.840.10008.5.1.4.1.1.2.2': 'Legacy Converted Enhanced CT Image Storage',
  '1.2.840.10008.5.1.4.1.1.3.1': 'Ultrasound Multi-frame Image Storage',
  '1.2.840.10008.5.1.4.1.1.4': 'MR Image Storage',
  '1.2.840.10008.5.1.4.1.1.4.1': 'Enhanced MR Image Storage',
  '1.2.840.10008.5.1.4.1.1.4.2': 'MR Spectroscopy Storage',
  '1.2.840.10008.5.1.4.1.1.4.3': 'Enhanced MR Color Image Storage',
  '1.2.840.10008.5.1.4.1.1.6.1': 'Ultrasound (US) Image Storage',
  '1.2.840.10008.5.1.4.1.1.6.2': 'Enhanced US Volume Storage',
  '1.2.840.10008.5.1.4.1.1.7': 'Secondary Capture (SC) Image Storage',
  '1.2.840.10008.5.1.4.1.1.7.1': 'Multi-frame Single Bit Secondary Capture Image Storage',
  '1.2.840.10008.5.1.4.1.1.7.2': 'Multi-frame Grayscale Byte Secondary Capture Image Storage',
  '1.2.840.10008.5.1.4.1.1.7.3': 'Multi-frame Grayscale Word Secondary Capture Image Storage',
  '1.2.840.10008.5.1.4.1.1.7.4': 'Multi-frame True Color Secondary Capture Image Storage',
  '1.2.840.10008.5.1.4.1.1.11.1': 'Grayscale Softcopy Presentation State Storage',
  '1.2.840.10008.5.1.4.1.1.12.1': 'X-Ray Angiographic (XA) Image Storage',
  '1.2.840.10008.5.1.4.1.1.12.2': 'X-Ray Radiofluoroscopic (RF) Image Storage',
  '1.2.840.10008.5.1.4.1.1.13.1.3': 'Breast Tomosynthesis Image Storage',
  '1.2.840.10008.5.1.4.1.1.20': 'Nuclear Medicine (NM) Image Storage',
  '1.2.840.10008.5.1.4.1.1.66': 'Raw Data Storage',
  '1.2.840.10008.5.1.4.1.1.66.4': 'Segmentation (SEG) Storage',
  '1.2.840.10008.5.1.4.1.1.67': 'Real World Value Mapping Storage',
  '1.2.840.10008.5.1.4.1.1.88.11': 'Basic Text SR Storage',
  '1.2.840.10008.5.1.4.1.1.88.22': 'Enhanced SR Storage',
  '1.2.840.10008.5.1.4.1.1.88.33': 'Comprehensive SR Storage',
  '1.2.840.10008.5.1.4.1.1.88.34': 'Comprehensive 3D SR Storage',
  '1.2.840.10008.5.1.4.1.1.88.67': 'X-Ray Radiation Dose SR Storage',
  '1.2.840.10008.5.1.4.1.1.104.1': 'Encapsulated PDF Storage',
  '1.2.840.10008.5.1.4.1.1.128': 'Positron Emission Tomography (PET) Image Storage',
  '1.2.840.10008.5.1.4.1.1.130': 'Enhanced PET Image Storage',
  '1.2.840.10008.5.1.4.1.1.481.1': 'RT Image Storage',
  '1.2.840.10008.5.1.4.1.1.481.2': 'RT Dose Storage',
  '1.2.840.10008.5.1.4.1.1.481.3': 'RT Structure Set Storage',
  '1.2.840.10008.5.1.4.1.1.481.5': 'RT Plan Storage',
};

/**
 * Resolve human-readable name for a well-known DICOM Transfer Syntax or SOP Class UID.
 * @param {string} uid
 * @returns {string|null}
 */
export function lookupUidName(uid) {
  const clean = (uid || '').replace(/\0+$/, '').trim();
  if (!clean) return null;
  if (TRANSFER_SYNTAXES[clean]) return TRANSFER_SYNTAXES[clean].name;
  if (KNOWN_SOP_UIDS[clean]) return KNOWN_SOP_UIDS[clean];
  return null;
}

/**
 * Compact format: [keyword, vr, vm, displayName]
 * If displayName is omitted, it is derived from keyword.
 */
const RAW_DICT = {
  // 0002 File Meta Information
  '00020000': ['FileMetaInformationGroupLength', 'UL', '1'],
  '00020001': ['FileMetaInformationVersion', 'OB', '1'],
  '00020002': ['MediaStorageSOPClassUID', 'UI', '1'],
  '00020003': ['MediaStorageSOPInstanceUID', 'UI', '1'],
  '00020010': ['TransferSyntaxUID', 'UI', '1'],
  '00020012': ['ImplementationClassUID', 'UI', '1'],
  '00020013': ['ImplementationVersionName', 'SH', '1'],
  '00020016': ['SourceApplicationEntityTitle', 'AE', '1'],
  '00020017': ['SendingApplicationEntityTitle', 'AE', '1'],
  '00020018': ['ReceivingApplicationEntityTitle', 'AE', '1'],
  '00020100': ['PrivateInformationCreatorUID', 'UI', '1'],
  '00020102': ['PrivateInformation', 'OB', '1'],

  // 0008 Identifying / Study / General
  '00080005': ['SpecificCharacterSet', 'CS', '1-n'],
  '00080008': ['ImageType', 'CS', '2-n'],
  '00080012': ['InstanceCreationDate', 'DA', '1'],
  '00080013': ['InstanceCreationTime', 'TM', '1'],
  '00080014': ['InstanceCreatorUID', 'UI', '1'],
  '00080016': ['SOPClassUID', 'UI', '1'],
  '00080018': ['SOPInstanceUID', 'UI', '1'],
  '00080020': ['StudyDate', 'DA', '1'],
  '00080021': ['SeriesDate', 'DA', '1'],
  '00080022': ['AcquisitionDate', 'DA', '1'],
  '00080023': ['ContentDate', 'DA', '1'],
  '0008002A': ['AcquisitionDateTime', 'DT', '1'],
  '00080030': ['StudyTime', 'TM', '1'],
  '00080031': ['SeriesTime', 'TM', '1'],
  '00080032': ['AcquisitionTime', 'TM', '1'],
  '00080033': ['ContentTime', 'TM', '1'],
  '00080050': ['AccessionNumber', 'SH', '1'],
  '00080052': ['QueryRetrieveLevel', 'CS', '1'],
  '00080060': ['Modality', 'CS', '1'],
  '00080061': ['ModalitiesInStudy', 'CS', '1-n'],
  '00080064': ['ConversionType', 'CS', '1'],
  '00080068': ['PresentationIntentType', 'CS', '1'],
  '00080070': ['Manufacturer', 'LO', '1'],
  '00080080': ['InstitutionName', 'LO', '1'],
  '00080081': ['InstitutionAddress', 'ST', '1'],
  '00080082': ['InstitutionCodeSequence', 'SQ', '1'],
  '00080090': ['ReferringPhysicianName', 'PN', '1'],
  '00080092': ['ReferringPhysicianAddress', 'ST', '1'],
  '00080094': ['ReferringPhysicianTelephoneNumbers', 'SH', '1-n'],
  '00080096': ['ReferringPhysicianIdentificationSequence', 'SQ', '1'],
  '00080100': ['CodeValue', 'SH', '1'],
  '00080102': ['CodingSchemeDesignator', 'SH', '1'],
  '00080103': ['CodingSchemeVersion', 'SH', '1'],
  '00080104': ['CodeMeaning', 'LO', '1'],
  '00080119': ['LongCodeValue', 'UC', '1'],
  '00080120': ['URNCodeValue', 'UR', '1'],
  '00080201': ['TimezoneOffsetFromUTC', 'SH', '1'],
  '00080202': ['ResponsibleOrganization', 'LO', '1'],
  '00081010': ['StationName', 'SH', '1'],
  '00081030': ['StudyDescription', 'LO', '1'],
  '00081032': ['ProcedureCodeSequence', 'SQ', '1'],
  '0008103E': ['SeriesDescription', 'LO', '1'],
  '0008103F': ['SeriesDescriptionCodeSequence', 'SQ', '1'],
  '00081040': ['InstitutionalDepartmentName', 'LO', '1'],
  '00081048': ['PhysiciansOfRecord', 'PN', '1-n'],
  '00081050': ['PerformingPhysicianName', 'PN', '1-n'],
  '00081060': ['NameOfPhysiciansReadingStudy', 'PN', '1-n'],
  '00081070': ['OperatorsName', 'PN', '1-n'],
  '00081080': ['AdmittingDiagnosesDescription', 'LO', '1-n'],
  '00081090': ['ManufacturerModelName', 'LO', '1'],
  '00081110': ['ReferencedStudySequence', 'SQ', '1'],
  '00081111': ['ReferencedPerformedProcedureStepSequence', 'SQ', '1'],
  '00081115': ['ReferencedSeriesSequence', 'SQ', '1'],
  '00081120': ['ReferencedPatientSequence', 'SQ', '1'],
  '00081140': ['ReferencedImageSequence', 'SQ', '1'],
  '0008114A': ['ReferencedInstanceSequence', 'SQ', '1'],
  '00081150': ['ReferencedSOPClassUID', 'UI', '1'],
  '00081155': ['ReferencedSOPInstanceUID', 'UI', '1'],
  '00081160': ['ReferencedFrameNumber', 'IS', '1-n'],
  '00082111': ['DerivationDescription', 'ST', '1'],
  '00082112': ['SourceImageSequence', 'SQ', '1'],
  '00082114': ['DerivationCodeSequence', 'SQ', '1'],
  '00082142': ['StartTrim', 'IS', '1'],
  '00082143': ['StopTrim', 'IS', '1'],
  '00082144': ['RecommendedDisplayFrameRate', 'IS', '1'],
  '00082218': ['AnatomicRegionSequence', 'SQ', '1'],
  '00082220': ['AnatomicRegionModifierSequence', 'SQ', '1'],
  '00082228': ['PrimaryAnatomicStructureSequence', 'SQ', '1'],
  '00089007': ['FrameType', 'CS', '4'],
  '00089123': ['CreatorVersionUID', 'UI', '1'],
  '00089205': ['PixelPresentation', 'CS', '1'],
  '00089206': ['VolumetricProperties', 'CS', '1'],
  '00089207': ['VolumeBasedCalculationTechnique', 'CS', '1'],
  '00089208': ['ComplexImageComponent', 'CS', '1'],
  '00089209': ['AcquisitionContrast', 'CS', '1'],

  // 0010 Patient
  '00100010': ['PatientName', 'PN', '1'],
  '00100020': ['PatientID', 'LO', '1'],
  '00100021': ['IssuerOfPatientID', 'LO', '1'],
  '00100030': ['PatientBirthDate', 'DA', '1'],
  '00100032': ['PatientBirthTime', 'TM', '1'],
  '00100040': ['PatientSex', 'CS', '1'],
  '00101000': ['OtherPatientIDs', 'LO', '1-n'],
  '00101001': ['OtherPatientNames', 'PN', '1-n'],
  '00101002': ['OtherPatientIDsSequence', 'SQ', '1'],
  '00101010': ['PatientAge', 'AS', '1'],
  '00101020': ['PatientSize', 'DS', '1'],
  '00101030': ['PatientWeight', 'DS', '1'],
  '00101040': ['PatientAddress', 'LO', '1'],
  '00102000': ['MedicalAlerts', 'LO', '1-n'],
  '00102110': ['Allergies', 'LO', '1-n'],
  '00102160': ['EthnicGroup', 'SH', '1'],
  '00102180': ['Occupation', 'SH', '1'],
  '001021B0': ['AdditionalPatientHistory', 'LT', '1'],
  '001021C0': ['PregnancyStatus', 'US', '1'],
  '00102201': ['PatientSpeciesDescription', 'LO', '1'],
  '00102292': ['PatientBreedDescription', 'LO', '1'],
  '00104000': ['PatientComments', 'LT', '1'],

  // 0012 Clinical Trial / De-identification
  '00120010': ['ClinicalTrialSponsorName', 'LO', '1'],
  '00120020': ['ClinicalTrialProtocolID', 'LO', '1'],
  '00120021': ['ClinicalTrialProtocolName', 'LO', '1'],
  '00120030': ['ClinicalTrialSiteID', 'LO', '1'],
  '00120031': ['ClinicalTrialSiteName', 'LO', '1'],
  '00120040': ['ClinicalTrialSubjectID', 'LO', '1'],
  '00120050': ['ClinicalTrialTimePointID', 'LO', '1'],
  '00120062': ['PatientIdentityRemoved', 'CS', '1'],
  '00120063': ['DeidentificationMethod', 'LO', '1-n'],
  '00120064': ['DeidentificationMethodCodeSequence', 'SQ', '1'],

  // 0018 Acquisition / Equipment / CT / MR / US / DX
  '00180010': ['ContrastBolusAgent', 'LO', '1'],
  '00180015': ['BodyPartExamined', 'CS', '1'],
  '00180020': ['ScanningSequence', 'CS', '1-n'],
  '00180021': ['SequenceVariant', 'CS', '1-n'],
  '00180022': ['ScanOptions', 'CS', '1-n'],
  '00180023': ['MRAcquisitionType', 'CS', '1'],
  '00180024': ['SequenceName', 'SH', '1'],
  '00180025': ['AngioFlag', 'CS', '1'],
  '00180050': ['SliceThickness', 'DS', '1'],
  '00180060': ['KVP', 'DS', '1'],
  '00180080': ['RepetitionTime', 'DS', '1'],
  '00180081': ['EchoTime', 'DS', '1'],
  '00180082': ['InversionTime', 'DS', '1'],
  '00180083': ['NumberOfAverages', 'DS', '1'],
  '00180084': ['ImagingFrequency', 'DS', '1'],
  '00180085': ['ImagedNucleus', 'SH', '1'],
  '00180086': ['EchoNumbers', 'IS', '1-n'],
  '00180087': ['MagneticFieldStrength', 'DS', '1'],
  '00180088': ['SpacingBetweenSlices', 'DS', '1'],
  '00180089': ['NumberOfPhaseEncodingSteps', 'IS', '1'],
  '00180090': ['DataCollectionDiameter', 'DS', '1'],
  '00180091': ['EchoTrainLength', 'IS', '1'],
  '00180093': ['PercentSampling', 'DS', '1'],
  '00180094': ['PercentPhaseFieldOfView', 'DS', '1'],
  '00180095': ['PixelBandwidth', 'DS', '1'],
  '00181000': ['DeviceSerialNumber', 'LO', '1'],
  '00181020': ['SoftwareVersions', 'LO', '1-n'],
  '00181030': ['ProtocolName', 'LO', '1'],
  '00181050': ['SpatialResolution', 'DS', '1'],
  '00181063': ['FrameTime', 'DS', '1'],
  '00181100': ['ReconstructionDiameter', 'DS', '1'],
  '00181110': ['DistanceSourceToDetector', 'DS', '1'],
  '00181111': ['DistanceSourceToPatient', 'DS', '1'],
  '00181120': ['GantryDetectorTilt', 'DS', '1'],
  '00181130': ['TableHeight', 'DS', '1'],
  '00181140': ['RotationDirection', 'CS', '1'],
  '00181150': ['ExposureTime', 'IS', '1'],
  '00181151': ['XRayTubeCurrent', 'IS', '1'],
  '00181152': ['Exposure', 'IS', '1'],
  '00181160': ['FilterType', 'SH', '1'],
  '00181170': ['GeneratorPower', 'IS', '1'],
  '00181190': ['FocalSpots', 'DS', '1-n'],
  '00181200': ['DateOfLastCalibration', 'DA', '1-n'],
  '00181210': ['ConvolutionKernel', 'SH', '1-n'],
  '00181250': ['ReceiveCoilName', 'SH', '1'],
  '00181251': ['TransmitCoilName', 'SH', '1'],
  '00181310': ['AcquisitionMatrix', 'US', '4'],
  '00181312': ['InPlanePhaseEncodingDirection', 'CS', '1'],
  '00181314': ['FlipAngle', 'DS', '1'],
  '00181316': ['SAR', 'DS', '1'],
  '00185100': ['PatientPosition', 'CS', '1'],
  '00185101': ['ViewPosition', 'CS', '1'],
  '00186011': ['SequenceOfUltrasoundRegions', 'SQ', '1'],
  '00186024': ['PhysicalUnitsXDirection', 'US', '1'],
  '00186026': ['PhysicalUnitsYDirection', 'US', '1'],
  '0018602C': ['PhysicalDeltaX', 'FD', '1'],
  '0018602E': ['PhysicalDeltaY', 'FD', '1'],
  '0018700A': ['DetectorID', 'SH', '1'],
  '0018700C': ['DateOfLastDetectorCalibration', 'DA', '1'],
  '00187050': ['FilterMaterial', 'CS', '1-n'],
  '00188150': ['ExposureTimeInuS', 'DS', '1'],
  '00188151': ['XRayTubeCurrentInuA', 'DS', '1'],
  '00189004': ['ContentQualification', 'CS', '1'],
  '00189005': ['PulseSequenceName', 'SH', '1'],
  '00189006': ['MRImagingModifierSequence', 'SQ', '1'],
  '00189073': ['AcquisitionDuration', 'FD', '1'],
  '00189087': ['DiffusionBValue', 'FD', '1'],
  '00189089': ['DiffusionGradientOrientation', 'FD', '3'],
  '00189302': ['AcquisitionType', 'CS', '1'],
  '00189305': ['RevolutionTime', 'FD', '1'],
  '00189306': ['SingleCollimationWidth', 'FD', '1'],
  '00189307': ['TotalCollimationWidth', 'FD', '1'],
  '00189309': ['TableSpeed', 'FD', '1'],
  '00189310': ['TableFeedPerRotation', 'FD', '1'],
  '00189311': ['SpiralPitchFactor', 'FD', '1'],
  '00189313': ['DataCollectionCenterPatient', 'FD', '3'],
  '00189323': ['ExposureModulationType', 'CS', '1-n'],
  '00189345': ['CTDIvol', 'FD', '1'],
  '00189346': ['CTDIPhantomTypeCodeSequence', 'SQ', '1'],
  '00189352': ['CalciumScoringMassFactorDevice', 'FL', '3'],
  '00181164': ['ImagerPixelSpacing', 'DS', '2'],
  '001811A0': ['BodyPartThickness', 'DS', '1'],
  '001811A2': ['CompressionForce', 'DS', '1'],
  '00181405': ['RelativeXRayExposure', 'IS', '1'],
  '00181510': ['PositionerPrimaryAngle', 'DS', '1'],
  '00181511': ['PositionerSecondaryAngle', 'DS', '1'],

  // 0020 Relationship / Geometry
  '0020000D': ['StudyInstanceUID', 'UI', '1'],
  '0020000E': ['SeriesInstanceUID', 'UI', '1'],
  '00200010': ['StudyID', 'SH', '1'],
  '00200011': ['SeriesNumber', 'IS', '1'],
  '00200012': ['AcquisitionNumber', 'IS', '1'],
  '00200013': ['InstanceNumber', 'IS', '1'],
  '00200020': ['PatientOrientation', 'CS', '2'],
  '00200032': ['ImagePositionPatient', 'DS', '3'],
  '00200037': ['ImageOrientationPatient', 'DS', '6'],
  '00200052': ['FrameOfReferenceUID', 'UI', '1'],
  '00200060': ['Laterality', 'CS', '1'],
  '00200062': ['ImageLaterality', 'CS', '1'],
  '00200100': ['TemporalPositionIdentifier', 'IS', '1'],
  '00200105': ['NumberOfTemporalPositions', 'IS', '1'],
  '00201040': ['PositionReferenceIndicator', 'LO', '1'],
  '00201041': ['SliceLocation', 'DS', '1'],
  '00201206': ['NumberOfStudyRelatedSeries', 'IS', '1'],
  '00201208': ['NumberOfStudyRelatedInstances', 'IS', '1'],
  '00201209': ['NumberOfSeriesRelatedInstances', 'IS', '1'],
  '00204000': ['ImageComments', 'LT', '1'],
  '00209056': ['StackID', 'SH', '1'],
  '00209057': ['InStackPositionNumber', 'UL', '1'],
  '00209111': ['FrameContentSequence', 'SQ', '1'],
  '00209113': ['PlanePositionSequence', 'SQ', '1'],
  '00209116': ['PlaneOrientationSequence', 'SQ', '1'],

  // 0028 Image Presentation / Pixel Attributes
  '00280002': ['SamplesPerPixel', 'US', '1'],
  '00280004': ['PhotometricInterpretation', 'CS', '1'],
  '00280006': ['PlanarConfiguration', 'US', '1'],
  '00280008': ['NumberOfFrames', 'IS', '1'],
  '00280009': ['FrameIncrementPointer', 'AT', '1-n'],
  '00280010': ['Rows', 'US', '1'],
  '00280011': ['Columns', 'US', '1'],
  '00280030': ['PixelSpacing', 'DS', '2'],
  '00280034': ['PixelAspectRatio', 'IS', '2'],
  '00280100': ['BitsAllocated', 'US', '1'],
  '00280101': ['BitsStored', 'US', '1'],
  '00280102': ['HighBit', 'US', '1'],
  '00280103': ['PixelRepresentation', 'US', '1'],
  '00280106': ['SmallestImagePixelValue', 'US', '1'],
  '00280107': ['LargestImagePixelValue', 'US', '1'],
  '00280120': ['PixelPaddingValue', 'US', '1'],
  '00280301': ['BurnedInAnnotation', 'CS', '1'],
  '00281040': ['PixelIntensityRelationship', 'CS', '1'],
  '00281041': ['PixelIntensityRelationshipSign', 'SS', '1'],
  '00281050': ['WindowCenter', 'DS', '1-n'],
  '00281051': ['WindowWidth', 'DS', '1-n'],
  '00281052': ['RescaleIntercept', 'DS', '1'],
  '00281053': ['RescaleSlope', 'DS', '1'],
  '00281054': ['RescaleType', 'LO', '1'],
  '00281055': ['WindowCenterWidthExplanation', 'LO', '1-n'],
  '00281056': ['VOILUTFunction', 'CS', '1'],
  '00282110': ['LossyImageCompression', 'CS', '1'],
  '00282112': ['LossyImageCompressionRatio', 'DS', '1-n'],
  '00282114': ['LossyImageCompressionMethod', 'CS', '1-n'],
  '00283000': ['ModalityLUTSequence', 'SQ', '1'],
  '00283010': ['VOILUTSequence', 'SQ', '1'],
  '00289110': ['PixelMeasuresSequence', 'SQ', '1'],
  '00289132': ['FrameVOILUTSequence', 'SQ', '1'],
  '00289145': ['PixelValueTransformationSequence', 'SQ', '1'],

  // 0032 / 0038 / 0040 Study / Visit / Procedure / SR
  '00321032': ['RequestingPhysician', 'PN', '1'],
  '00321033': ['RequestingService', 'LO', '1'],
  '00321060': ['RequestedProcedureDescription', 'LO', '1'],
  '00321064': ['RequestedProcedureCodeSequence', 'SQ', '1'],
  '00324000': ['StudyComments', 'LT', '1'],
  '00380010': ['AdmissionID', 'LO', '1'],
  '00380300': ['CurrentPatientLocation', 'LO', '1'],
  '00380500': ['PatientState', 'LO', '1'],
  '00400001': ['ScheduledStationAETitle', 'AE', '1-n'],
  '00400002': ['ScheduledProcedureStepStartDate', 'DA', '1'],
  '00400003': ['ScheduledProcedureStepStartTime', 'TM', '1'],
  '00400007': ['ScheduledProcedureStepDescription', 'LO', '1'],
  '00400009': ['ScheduledProcedureStepID', 'SH', '1'],
  '00400241': ['PerformedStationAETitle', 'AE', '1'],
  '00400244': ['PerformedProcedureStepStartDate', 'DA', '1'],
  '00400245': ['PerformedProcedureStepStartTime', 'TM', '1'],
  '00400253': ['PerformedProcedureStepID', 'SH', '1'],
  '00400254': ['PerformedProcedureStepDescription', 'LO', '1'],
  '00400275': ['RequestAttributesSequence', 'SQ', '1'],
  '004008EA': ['MeasurementUnitsCodeSequence', 'SQ', '1'],
  '00401001': ['RequestedProcedureID', 'SH', '1'],
  '0040A010': ['RelationshipType', 'CS', '1'],
  '0040A027': ['VerifyingOrganization', 'LO', '1'],
  '0040A030': ['VerificationDateTime', 'DT', '1'],
  '0040A032': ['ObservationDateTime', 'DT', '1'],
  '0040A040': ['ValueType', 'CS', '1'],
  '0040A043': ['ConceptNameCodeSequence', 'SQ', '1'],
  '0040A050': ['ContinuityOfContent', 'CS', '1'],
  '0040A073': ['VerifyingObserverSequence', 'SQ', '1'],
  '0040A075': ['VerifyingObserverName', 'PN', '1'],
  '0040A078': ['AuthorObserverSequence', 'SQ', '1'],
  '0040A07A': ['ParticipantSequence', 'SQ', '1'],
  '0040A088': ['VerifyingObserverIdentificationCodeSequence', 'SQ', '1'],
  '0040A120': ['DateTime', 'DT', '1'],
  '0040A121': ['Date', 'DA', '1'],
  '0040A122': ['Time', 'TM', '1'],
  '0040A123': ['PersonName', 'PN', '1'],
  '0040A124': ['UID', 'UI', '1'],
  '0040A160': ['TextValue', 'UT', '1'],
  '0040A168': ['ConceptCodeSequence', 'SQ', '1'],
  '0040A170': ['PurposeOfReferenceCodeSequence', 'SQ', '1'],
  '0040A300': ['MeasuredValueSequence', 'SQ', '1'],
  '0040A30A': ['NumericValue', 'DS', '1-n'],
  '0040A360': ['PredecessorDocumentsSequence', 'SQ', '1'],
  '0040A370': ['ReferencedRequestSequence', 'SQ', '1'],
  '0040A372': ['PerformedProcedureCodeSequence', 'SQ', '1'],
  '0040A375': ['CurrentRequestedProcedureEvidenceSequence', 'SQ', '1'],
  '0040A385': ['PertinentOtherEvidenceSequence', 'SQ', '1'],
  '0040A491': ['CompletionFlag', 'CS', '1'],
  '0040A493': ['VerificationFlag', 'CS', '1'],
  '0040A504': ['ContentTemplateSequence', 'SQ', '1'],
  '0040A525': ['IdenticalDocumentsSequence', 'SQ', '1'],
  '0040A730': ['ContentSequence', 'SQ', '1'],
  '0040DB00': ['TemplateIdentifier', 'CS', '1'],
  '0040DB0D': ['TemplateExtensionFlag', 'CS', '1'],
  '0040DB73': ['ReferencedContentItemIdentifier', 'UL', '1-n'],

  // 0054 Nuclear Medicine / PET
  '00540016': ['RadiopharmaceuticalInformationSequence', 'SQ', '1'],
  '00540081': ['NumberOfSlices', 'US', '1'],
  '00540410': ['PatientOrientationCodeSequence', 'SQ', '1'],
  '00541000': ['SeriesType', 'CS', '2'],
  '00541001': ['Units', 'CS', '1'],
  '00541100': ['RandomsCorrectionMethod', 'CS', '1'],
  '00541101': ['AttenuationCorrectionMethod', 'LO', '1'],
  '00541102': ['DecayCorrection', 'CS', '1'],
  '00541103': ['ReconstructionMethod', 'LO', '1'],
  '00541300': ['FrameReferenceTime', 'DS', '1'],
  '00541321': ['DecayFactor', 'DS', '1'],

  // 0062 Segmentation (DICOM SEG)
  '00620001': ['SegmentationType', 'CS', '1'],
  '00620002': ['SegmentSequence', 'SQ', '1'],
  '00620003': ['SegmentedPropertyCategoryCodeSequence', 'SQ', '1'],
  '00620004': ['SegmentNumber', 'US', '1'],
  '00620005': ['SegmentLabel', 'LO', '1'],
  '00620006': ['SegmentDescription', 'ST', '1'],
  '00620008': ['SegmentAlgorithmType', 'CS', '1'],
  '00620009': ['SegmentAlgorithmName', 'LO', '1'],
  '0062000A': ['SegmentIdentificationSequence', 'SQ', '1'],
  '0062000B': ['ReferencedSegmentNumber', 'US', '1-n'],
  '0062000D': ['RecommendedDisplayCIELabValue', 'US', '3'],
  '0062000F': ['SegmentedPropertyTypeCodeSequence', 'SQ', '1'],

  // 0070 Presentation State / Annotations
  '00700001': ['GraphicAnnotationSequence', 'SQ', '1'],
  '00700002': ['GraphicLayer', 'CS', '1'],
  '00700008': ['TextObjectSequence', 'SQ', '1'],
  '00700009': ['GraphicObjectSequence', 'SQ', '1'],
  '00700006': ['UnformattedTextValue', 'ST', '1'],
  '00700022': ['GraphicData', 'FL', '2-n'],
  '00700023': ['GraphicType', 'CS', '1'],
  '00700041': ['ImageHorizontalFlip', 'CS', '1'],
  '00700042': ['ImageRotation', 'US', '1'],
  '00700080': ['ContentLabel', 'CS', '1'],
  '00700081': ['ContentDescription', 'LO', '1'],
  '00700082': ['PresentationCreationDate', 'DA', '1'],
  '00700083': ['PresentationCreationTime', 'TM', '1'],
  '00700084': ['ContentCreatorsName', 'PN', '1'],

  // 2050 Presentation LUT
  '20500020': ['PresentationLUTShape', 'CS', '1'],

  // 5200 Enhanced Multi-frame
  '52009229': ['SharedFunctionalGroupsSequence', 'SQ', '1'],
  '52009230': ['PerFrameFunctionalGroupsSequence', 'SQ', '1'],

  // 3004 / 3006 / 300A / 300C Radiotherapy
  '30040002': ['DoseUnits', 'CS', '1'],
  '30040004': ['DoseType', 'CS', '1'],
  '3004000A': ['DoseSummationType', 'CS', '1'],
  '3004000C': ['GridFrameOffsetVector', 'DS', '2-n'],
  '3004000E': ['DoseGridScaling', 'DS', '1'],
  '30060002': ['StructureSetLabel', 'SH', '1'],
  '30060004': ['StructureSetName', 'LO', '1'],
  '30060008': ['StructureSetDate', 'DA', '1'],
  '30060009': ['StructureSetTime', 'TM', '1'],
  '30060010': ['ReferencedFrameOfReferenceSequence', 'SQ', '1'],
  '30060020': ['StructureSetROISequence', 'SQ', '1'],
  '30060022': ['ROINumber', 'IS', '1'],
  '30060024': ['ReferencedFrameOfReferenceUID', 'UI', '1'],
  '30060026': ['ROIName', 'LO', '1'],
  '3006002A': ['ROIDisplayColor', 'IS', '3'],
  '30060039': ['ROIContourSequence', 'SQ', '1'],
  '30060040': ['ContourSequence', 'SQ', '1'],
  '30060042': ['ContourGeometricType', 'CS', '1'],
  '30060046': ['NumberOfContourPoints', 'IS', '1'],
  '30060050': ['ContourData', 'DS', '3-3n'],
  '30060080': ['RTROIObservationsSequence', 'SQ', '1'],
  '30060084': ['ReferencedROINumber', 'IS', '1'],
  '300600A4': ['RTROIInterpretedType', 'CS', '1'],
  '300A0002': ['RTPlanLabel', 'SH', '1'],
  '300A0003': ['RTPlanName', 'LO', '1'],
  '300A0006': ['RTPlanDate', 'DA', '1'],
  '300A0007': ['RTPlanTime', 'TM', '1'],
  '300A00B0': ['BeamSequence', 'SQ', '1'],
  '300A00C2': ['BeamName', 'LO', '1'],
  '300C0002': ['ReferencedRTPlanSequence', 'SQ', '1'],
  '300C0060': ['ReferencedStructureSetSequence', 'SQ', '1'],

  // 7FE0 Pixel Data
  '7FE00010': ['PixelData', 'OW', '1'],
  '7FE00008': ['FloatPixelData', 'OF', '1'],
  '7FE00009': ['DoubleFloatPixelData', 'OD', '1'],
};

function keywordToDisplayName(keyword) {
  return keyword
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
}

/** @type {Map<string, { tag: string, formattedTag: string, keyword: string, name: string, vr: string, vm: string }>} */
export const DICOM_DICTIONARY = new Map();

for (const [hex, entry] of Object.entries(RAW_DICT)) {
  const [keyword, vr, vm, explicitName] = entry;
  const formattedTag = `(${hex.slice(0, 4)},${hex.slice(4, 8)})`;
  DICOM_DICTIONARY.set(hex, {
    tag: hex,
    formattedTag,
    keyword,
    name: explicitName || keywordToDisplayName(keyword),
    vr,
    vm,
  });
}

export function formatTag(group, element) {
  const g = group.toString(16).toUpperCase().padStart(4, '0');
  const e = element.toString(16).toUpperCase().padStart(4, '0');
  return `(${g},${e})`;
}

export function tagHex(group, element) {
  return (
    group.toString(16).toUpperCase().padStart(4, '0') +
    element.toString(16).toUpperCase().padStart(4, '0')
  );
}

export function parseTagString(input) {
  const cleaned = (input || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (cleaned.length !== 8) return null;
  const group = parseInt(cleaned.slice(0, 4), 16);
  const element = parseInt(cleaned.slice(4, 8), 16);
  return { group, element, hex: cleaned, formatted: formatTag(group, element) };
}

/**
 * Lookup tag metadata including Private Tag & Group Length handling.
 * @param {number} group
 * @param {number} element
 * @param {Map<string, string>} [privateCreators]
 */
export function lookupTag(group, element, privateCreators) {
  const hex = tagHex(group, element);
  const std = DICOM_DICTIONARY.get(hex);
  if (std) {
    return { ...std, isPrivate: false };
  }

  if (element === 0x0000) {
    return {
      tag: hex,
      formattedTag: formatTag(group, element),
      keyword: 'GroupLength',
      name: `Group ${group.toString(16).toUpperCase().padStart(4, '0')} Length`,
      vr: 'UL',
      vm: '1',
      isPrivate: (group & 1) === 1,
    };
  }

  // Private tag (odd group number)
  if ((group & 1) === 1) {
    if (element >= 0x0010 && element <= 0x00ff) {
      return {
        tag: hex,
        formattedTag: formatTag(group, element),
        keyword: 'PrivateCreator',
        name: 'Private Creator',
        vr: 'LO',
        vm: '1',
        isPrivate: true,
        isPrivateCreator: true,
      };
    }
    const block = (element >> 8) & 0xff;
    const creatorKey = `${group.toString(16).toUpperCase().padStart(4, '0')}:${block.toString(16).toUpperCase().padStart(2, '0')}`;
    const creator = privateCreators?.get(creatorKey);
    return {
      tag: hex,
      formattedTag: formatTag(group, element),
      keyword: creator ? `Private_${creator.replace(/[^A-Za-z0-9]/g, '')}` : 'PrivateTag',
      name: creator ? `Private Tag [${creator}]` : 'Private Tag',
      vr: 'UN',
      vm: '1',
      isPrivate: true,
      privateCreator: creator || null,
    };
  }

  // Repeating overlay group 60xx
  if (group >= 0x6000 && group <= 0x60ff && (group & 1) === 0) {
    const overlayMap = {
      0x0010: ['OverlayRows', 'US', '1'],
      0x0011: ['OverlayColumns', 'US', '1'],
      0x0022: ['OverlayDescription', 'LO', '1'],
      0x0040: ['OverlayType', 'CS', '1'],
      0x0050: ['OverlayOrigin', 'SS', '2'],
      0x0100: ['OverlayBitsAllocated', 'US', '1'],
      0x0102: ['OverlayBitPosition', 'US', '1'],
      0x3000: ['OverlayData', 'OW', '1'],
    };
    const hit = overlayMap[element];
    if (hit) {
      return {
        tag: hex,
        formattedTag: formatTag(group, element),
        keyword: hit[0],
        name: keywordToDisplayName(hit[0]),
        vr: hit[1],
        vm: hit[2],
        isPrivate: false,
      };
    }
  }

  return {
    tag: hex,
    formattedTag: formatTag(group, element),
    keyword: 'UnknownTag',
    name: 'Unknown Standard Tag',
    vr: 'UN',
    vm: '1',
    isPrivate: false,
  };
}

/**
 * Search standard dictionary entries for Add Tag autocomplete.
 */
export function searchDictionary(query, limit = 25) {
  const q = (query || '').trim().toLowerCase();
  const isTagLike = /^[0-9a-f(),\s]+$/.test(q);
  const qHex = isTagLike ? q.replace(/[^0-9a-f]/g, '') : '';
  const results = [];
  for (const entry of DICOM_DICTIONARY.values()) {
    if (
      !q ||
      (qHex !== '' && entry.tag.toLowerCase().includes(qHex)) ||
      entry.formattedTag.toLowerCase().includes(q) ||
      entry.keyword.toLowerCase().includes(q) ||
      entry.name.toLowerCase().includes(q)
    ) {
      results.push(entry);
      if (results.length >= limit) break;
    }
  }
  return results;
}
