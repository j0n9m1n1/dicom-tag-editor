/**
 * DICOM PS3.5 Value Representation (VR) specifications & real-time validator.
 */

export const VR_32BIT_LENGTH = new Set([
  'OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV',
]);

export const BINARY_VRS = new Set([
  'OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'UN',
]);

export const NUMERIC_VRS = new Set([
  'FL', 'FD', 'SL', 'SS', 'SV', 'UL', 'US', 'UV',
]);

export const STRING_NUMERIC_VRS = new Set(['DS', 'IS']);

export const NO_MULTIVALUE_VRS = new Set([
  'LT', 'ST', 'UT', 'UR', 'SQ', 'OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'UN',
]);

export const NULL_PAD_VRS = new Set([
  'UI', 'OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'UN',
]);

/** @type {Record<string, {
 *   code: string,
 *   name: string,
 *   category: 'string'|'number'|'date'|'binary'|'sequence'|'tag',
 *   maxLength: number|null,
 *   fixedLength: number|null,
 *   lengthUnit: 'bytes'|'chars',
 *   padding: 'space'|'null'|'none',
 *   allowMultiValue: boolean,
 *   formatHint: string,
 *   description: string,
 * }>} */
export const VR_SPECS = {
  AE: {
    code: 'AE', name: 'Application Entity', category: 'string',
    maxLength: 16, fixedLength: null, lengthUnit: 'bytes', padding: 'space', allowMultiValue: true,
    formatHint: '최대 16바이트 ASCII (제어문자/\\ 제외)',
    description: 'DICOM 네트워크 노드(AE Title) 식별 문자열입니다. 앞뒤 공백은 무시됩니다.',
  },
  AS: {
    code: 'AS', name: 'Age String', category: 'date',
    maxLength: 4, fixedLength: 4, lengthUnit: 'bytes', padding: 'space', allowMultiValue: true,
    formatHint: 'nnnD | nnnW | nnnM | nnnY (예: 035Y)',
    description: '3자리 숫자 + 단위(D=일, W=주, M=월, Y=년)로 이루어진 고정 4바이트 나이 문자열입니다.',
  },
  AT: {
    code: 'AT', name: 'Attribute Tag', category: 'tag',
    maxLength: null, fixedLength: 4, lengthUnit: 'bytes', padding: 'none', allowMultiValue: true,
    formatHint: '(GGGG,EEEE) 형식 (예: (0010,0020))',
    description: '다른 DICOM 데이터 엘리먼트의 태그(Group, Element 16비트 쌍)를 참조합니다.',
  },
  CS: {
    code: 'CS', name: 'Code String', category: 'string',
    maxLength: 16, fixedLength: null, lengthUnit: 'bytes', padding: 'space', allowMultiValue: true,
    formatHint: '대문자 A-Z, 숫자 0-9, 공백, 언더바(_) / 최대 16바이트',
    description: '표준화 코드 문자열입니다(예: CT, MR, MONOCHROME2, ORIGINAL\\PRIMARY).',
  },
  DA: {
    code: 'DA', name: 'Date', category: 'date',
    maxLength: 8, fixedLength: 8, lengthUnit: 'bytes', padding: 'space', allowMultiValue: true,
    formatHint: 'YYYYMMDD (예: 20261119)',
    description: '그레고리력 날짜 문자열입니다. 하이픈 없이 8자리 숫자로 기록합니다.',
  },
  DS: {
    code: 'DS', name: 'Decimal String', category: 'number',
    maxLength: 16, fixedLength: null, lengthUnit: 'bytes', padding: 'space', allowMultiValue: true,
    formatHint: '고정/부동 소수점 문자열 (예: -12.5, 1.5e-3) / 항목당 최대 16바이트',
    description: '십진 실수를 ASCII 문자열로 표현합니다(예: PixelSpacing, WindowCenter).',
  },
  DT: {
    code: 'DT', name: 'Date Time', category: 'date',
    maxLength: 26, fixedLength: null, lengthUnit: 'bytes', padding: 'space', allowMultiValue: true,
    formatHint: 'YYYYMMDDHHMMSS.FFFFFF&ZZXX',
    description: '날짜, 시간 및 선택적 타임존 오프셋(+/-HHMM)을 결합한 타임스탬프입니다.',
  },
  FL: {
    code: 'FL', name: 'Floating Point Single', category: 'number',
    maxLength: null, fixedLength: 4, lengthUnit: 'bytes', padding: 'none', allowMultiValue: true,
    formatHint: '32-bit IEEE 754 단정밀도 실수',
    description: '4바이트 바이너리 부동소수점 값입니다.',
  },
  FD: {
    code: 'FD', name: 'Floating Point Double', category: 'number',
    maxLength: null, fixedLength: 8, lengthUnit: 'bytes', padding: 'none', allowMultiValue: true,
    formatHint: '64-bit IEEE 754 배정밀도 실수',
    description: '8바이트 바이너리 배정밀도 부동소수점 값입니다.',
  },
  IS: {
    code: 'IS', name: 'Integer String', category: 'number',
    maxLength: 12, fixedLength: null, lengthUnit: 'bytes', padding: 'space', allowMultiValue: true,
    formatHint: '정수 문자열 (-2147483648 ~ 2147483647) / 항목당 최대 12바이트',
    description: '부호 있는 32비트 정수를 ASCII 문자열로 표현합니다(예: InstanceNumber).',
  },
  LO: {
    code: 'LO', name: 'Long String', category: 'string',
    maxLength: 64, fixedLength: null, lengthUnit: 'chars', padding: 'space', allowMultiValue: true,
    formatHint: '최대 64자 (SpecificCharacterSet 인코딩 적용)',
    description: '일반 텍스트 문자열입니다(예: PatientID, StudyDescription). 백슬래시(\\)는 다중값 구분자입니다.',
  },
  LT: {
    code: 'LT', name: 'Long Text', category: 'string',
    maxLength: 10240, fixedLength: null, lengthUnit: 'chars', padding: 'space', allowMultiValue: false,
    formatHint: '최대 10,240자 (VM=1 고정, 줄바꿈/\\ 허용)',
    description: '긴 서술형 텍스트입니다. 백슬래시(\\)가 구분자가 아닌 일반 문자로 취급됩니다.',
  },
  OB: {
    code: 'OB', name: 'Other Byte', category: 'binary',
    maxLength: null, fixedLength: null, lengthUnit: 'bytes', padding: 'null', allowMultiValue: false,
    formatHint: '임의 바이트 스트림 (8-bit 단위)',
    description: '바이트 단위 바이너리 데이터입니다(예: 압축 PixelData, 8-bit 픽셀, Private 바이너리).',
  },
  OD: {
    code: 'OD', name: 'Other Double', category: 'binary',
    maxLength: null, fixedLength: null, lengthUnit: 'bytes', padding: 'none', allowMultiValue: false,
    formatHint: '64-bit IEEE 754 실수 바이너리 스트림',
    description: '64비트 배정밀도 실수 배열 바이너리 데이터입니다.',
  },
  OF: {
    code: 'OF', name: 'Other Float', category: 'binary',
    maxLength: null, fixedLength: null, lengthUnit: 'bytes', padding: 'none', allowMultiValue: false,
    formatHint: '32-bit IEEE 754 실수 바이너리 스트림',
    description: '32비트 단정밀도 실수 배열 바이너리 데이터입니다.',
  },
  OL: {
    code: 'OL', name: 'Other Long', category: 'binary',
    maxLength: null, fixedLength: null, lengthUnit: 'bytes', padding: 'none', allowMultiValue: false,
    formatHint: '32-bit 바이너리 워드 스트림',
    description: '32비트 워드 배열 바이너리 데이터입니다.',
  },
  OV: {
    code: 'OV', name: 'Other 64-bit Very Long', category: 'binary',
    maxLength: null, fixedLength: null, lengthUnit: 'bytes', padding: 'none', allowMultiValue: false,
    formatHint: '64-bit 바이너리 워드 스트림',
    description: '64비트 워드 배열 바이너리 데이터입니다.',
  },
  OW: {
    code: 'OW', name: 'Other Word', category: 'binary',
    maxLength: null, fixedLength: null, lengthUnit: 'bytes', padding: 'none', allowMultiValue: false,
    formatHint: '16-bit 워드 바이너리 스트림 (PixelData 등)',
    description: '16비트 워드 단위 바이너리 데이터입니다(예: 16-bit 비압축 PixelData).',
  },
  PN: {
    code: 'PN', name: 'Person Name', category: 'string',
    maxLength: 64, fixedLength: null, lengthUnit: 'chars', padding: 'space', allowMultiValue: true,
    formatHint: '성^이름^중간이름^접두^접미 (그룹당 최대 64자, =로 표기그룹 구분)',
    description: '사람 이름을 최대 5개 구성요소(^) 및 3개 문자그룹(=: 알파벳=표의=표음)으로 표현합니다.',
  },
  SH: {
    code: 'SH', name: 'Short String', category: 'string',
    maxLength: 16, fixedLength: null, lengthUnit: 'chars', padding: 'space', allowMultiValue: true,
    formatHint: '최대 16자 (SpecificCharacterSet 인코딩 적용)',
    description: '짧은 문자열입니다(예: AccessionNumber, StationName, StudyID).',
  },
  SL: {
    code: 'SL', name: 'Signed Long', category: 'number',
    maxLength: null, fixedLength: 4, lengthUnit: 'bytes', padding: 'none', allowMultiValue: true,
    formatHint: '32-bit 부호 있는 정수 (-2,147,483,648 ~ 2,147,483,647)',
    description: '4바이트 signed integer 바이너리 값입니다.',
  },
  SQ: {
    code: 'SQ', name: 'Sequence of Items', category: 'sequence',
    maxLength: null, fixedLength: null, lengthUnit: 'bytes', padding: 'none', allowMultiValue: false,
    formatHint: '0개 이상의 중첩 Item(데이터셋) 목록',
    description: '하위 태그 묶음(Item)을 계층적으로 포함하는 시퀀스 컨테이너입니다.',
  },
  SS: {
    code: 'SS', name: 'Signed Short', category: 'number',
    maxLength: null, fixedLength: 2, lengthUnit: 'bytes', padding: 'none', allowMultiValue: true,
    formatHint: '16-bit 부호 있는 정수 (-32,768 ~ 32,767)',
    description: '2바이트 signed short 바이너리 값입니다.',
  },
  ST: {
    code: 'ST', name: 'Short Text', category: 'string',
    maxLength: 1024, fixedLength: null, lengthUnit: 'chars', padding: 'space', allowMultiValue: false,
    formatHint: '최대 1,024자 (VM=1 고정)',
    description: '중간 길이의 서술형 텍스트입니다(예: InstitutionAddress).',
  },
  SV: {
    code: 'SV', name: 'Signed 64-bit Very Long', category: 'number',
    maxLength: null, fixedLength: 8, lengthUnit: 'bytes', padding: 'none', allowMultiValue: true,
    formatHint: '64-bit 부호 있는 정수',
    description: '8바이트 signed integer 바이너리 값입니다.',
  },
  TM: {
    code: 'TM', name: 'Time', category: 'date',
    maxLength: 14, fixedLength: null, lengthUnit: 'bytes', padding: 'space', allowMultiValue: true,
    formatHint: 'HHMMSS.FFFFFF (예: 143025 또는 143025.500)',
    description: '24시간제 시각 문자열입니다. 시(HH)만 또는 시분(HHMM)까지 축약 가능합니다.',
  },
  UC: {
    code: 'UC', name: 'Unlimited Characters', category: 'string',
    maxLength: null, fixedLength: null, lengthUnit: 'chars', padding: 'space', allowMultiValue: true,
    formatHint: '길이 제한 없는 문자열 (다중값 \\ 허용)',
    description: '길이 제한 없이 다중값을 지원해야 하는 문자열에 사용합니다.',
  },
  UI: {
    code: 'UI', name: 'Unique Identifier (UID)', category: 'string',
    maxLength: 64, fixedLength: null, lengthUnit: 'bytes', padding: 'null', allowMultiValue: true,
    formatHint: '숫자(0-9)와 점(.)만 허용 / 최대 64바이트 (NULL 패딩)',
    description: '전 세계 고유 식별자(OID 형식)입니다. 0으로 시작하는 다자리 세그먼트나 끝 점(.)은 허용되지 않습니다.',
  },
  UL: {
    code: 'UL', name: 'Unsigned Long', category: 'number',
    maxLength: null, fixedLength: 4, lengthUnit: 'bytes', padding: 'none', allowMultiValue: true,
    formatHint: '32-bit 부호 없는 정수 (0 ~ 4,294,967,295)',
    description: '4바이트 unsigned integer 바이너리 값입니다.',
  },
  UN: {
    code: 'UN', name: 'Unknown', category: 'binary',
    maxLength: null, fixedLength: null, lengthUnit: 'bytes', padding: 'null', allowMultiValue: false,
    formatHint: '알 수 없는 VR의 원시 바이트 스트림',
    description: 'VR이 명시되지 않았거나 비표준인 원시 바이트 데이터입니다.',
  },
  UR: {
    code: 'UR', name: 'Universal Resource Identifier / Locator', category: 'string',
    maxLength: null, fixedLength: null, lengthUnit: 'bytes', padding: 'space', allowMultiValue: false,
    formatHint: 'RFC 3986 URI / URL (VM=1 고정)',
    description: '웹 URL 또는 URI 문자열입니다.',
  },
  US: {
    code: 'US', name: 'Unsigned Short', category: 'number',
    maxLength: null, fixedLength: 2, lengthUnit: 'bytes', padding: 'none', allowMultiValue: true,
    formatHint: '16-bit 부호 없는 정수 (0 ~ 65,535)',
    description: '2바이트 unsigned short 바이너리 값입니다(예: Rows, Columns, BitsAllocated).',
  },
  UT: {
    code: 'UT', name: 'Unlimited Text', category: 'string',
    maxLength: null, fixedLength: null, lengthUnit: 'chars', padding: 'space', allowMultiValue: false,
    formatHint: '길이 제한 없는 텍스트 (VM=1 고정)',
    description: '길이 제한이 없는 대용량 텍스트입니다.',
  },
  UV: {
    code: 'UV', name: 'Unsigned 64-bit Very Long', category: 'number',
    maxLength: null, fixedLength: 8, lengthUnit: 'bytes', padding: 'none', allowMultiValue: true,
    formatHint: '64-bit 부호 없는 정수 (0 이상)',
    description: '8바이트 unsigned integer 바이너리 값입니다.',
  },
};

export const ALL_VR_CODES = Object.keys(VR_SPECS);

export function getVrSpec(vr) {
  return VR_SPECS[vr] || VR_SPECS.UN;
}

/**
 * Validate a tag's string representation against DICOM PS3.5 VR rules.
 * @param {string} vr
 * @param {string} value
 * @returns {{ valid: boolean, severity: 'ok'|'warning'|'error', messages: string[] }}
 */
export function validateVrValue(vr, value) {
  const spec = getVrSpec(vr);
  const messages = [];
  let severity = 'ok';

  if (spec.category === 'binary' || spec.category === 'sequence') {
    return { valid: true, severity: 'ok', messages: [] };
  }

  const raw = value ?? '';
  if (raw === '') {
    return { valid: true, severity: 'ok', messages: [] };
  }

  const parts = spec.allowMultiValue ? raw.split('\\') : [raw];
  const encoder = new TextEncoder();

  const pushError = (msg) => {
    messages.push(msg);
    severity = 'error';
  };
  const pushWarn = (msg) => {
    messages.push(msg);
    if (severity === 'ok') severity = 'warning';
  };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const prefix = parts.length > 1 ? `[항목 #${i + 1}] ` : '';

    // Empty item inside multi-value is allowed in DICOM (Type 2 / empty component), skip format checks if empty
    if (part === '') continue;

    switch (vr) {
      case 'AE': {
        const bytes = encoder.encode(part).length;
        if (bytes > 16) pushError(`${prefix}최대 16바이트 초과 (현재 ${bytes}바이트)`);
        if (/[^\x20-\x7E]/.test(part)) pushError(`${prefix}ASCII 인쇄 가능 문자만 허용됩니다.`);
        break;
      }
      case 'AS': {
        if (!/^\d{3}[DWMY]$/.test(part)) {
          pushError(`${prefix}형식 오류: nnnD / nnnW / nnnM / nnnY (예: 042Y)`);
        }
        break;
      }
      case 'AT': {
        if (!/^\(?[0-9A-Fa-f]{4},?\s*[0-9A-Fa-f]{4}\)?$/.test(part.trim())) {
          pushError(`${prefix}태그 형식 오류: (GGGG,EEEE) 형식이어야 합니다.`);
        }
        break;
      }
      case 'CS': {
        const bytes = encoder.encode(part).length;
        if (bytes > 16) pushError(`${prefix}최대 16바이트 초과 (현재 ${bytes}바이트)`);
        if (!/^[A-Z0-9 _]+$/.test(part)) {
          pushError(`${prefix}영문 대문자(A-Z), 숫자(0-9), 공백, 언더바(_)만 허용됩니다.`);
        }
        break;
      }
      case 'DA': {
        if (!/^\d{8}$/.test(part)) {
          pushError(`${prefix}YYYYMMDD 8자리 숫자여야 합니다.`);
        } else {
          const y = Number(part.slice(0, 4));
          const m = Number(part.slice(4, 6));
          const d = Number(part.slice(6, 8));
          const dt = new Date(Date.UTC(y, m - 1, d));
          if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
            pushError(`${prefix}존재하지 않는 달력 날짜입니다 (${y}-${m}-${d}).`);
          }
        }
        break;
      }
      case 'TM': {
        if (!/^\d{2}(\d{2}(\d{2}(\.\d{1,6})?)?)?$/.test(part.trim())) {
          pushError(`${prefix}HHMMSS.FFFFFF 형식이어야 합니다.`);
        } else {
          const t = part.trim();
          const hh = Number(t.slice(0, 2));
          const mm = t.length >= 4 ? Number(t.slice(2, 4)) : 0;
          const ss = t.length >= 6 ? Number(t.slice(4, 6)) : 0;
          if (hh > 23 || mm > 59 || ss > 60) {
            pushError(`${prefix}시(00-23), 분(00-59), 초(00-60) 범위를 벗어났습니다.`);
          }
        }
        break;
      }
      case 'DT': {
        if (encoder.encode(part).length > 26) {
          pushError(`${prefix}최대 26바이트 초과`);
        }
        if (!/^\d{4}(\d{2}(\d{2}(\d{2}(\d{2}(\d{2}(\.\d{1,6})?)?)?)?)?)?([+-]\d{4})?$/.test(part.trim())) {
          pushError(`${prefix}YYYYMMDDHHMMSS.FFFFFF&ZZXX 형식이어야 합니다.`);
        }
        break;
      }
      case 'DS': {
        const trimmed = part.trim();
        if (encoder.encode(part).length > 16) {
          pushError(`${prefix}항목당 최대 16바이트 초과`);
        }
        if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
          pushError(`${prefix}유효한 십진 실수 형식이 아닙니다.`);
        }
        break;
      }
      case 'IS': {
        const trimmed = part.trim();
        if (encoder.encode(part).length > 12) {
          pushError(`${prefix}항목당 최대 12바이트 초과`);
        }
        if (!/^[+-]?\d+$/.test(trimmed)) {
          pushError(`${prefix}유효한 정수가 아닙니다.`);
        } else {
          const num = Number(trimmed);
          if (num < -2147483648 || num > 2147483647) {
            pushError(`${prefix}32-bit 정수 범위를 벗어났습니다.`);
          }
        }
        break;
      }
      case 'UI': {
        const trimmed = part.replace(/\0+$/, '');
        const bytes = encoder.encode(trimmed).length;
        if (bytes > 64) pushError(`${prefix}UID는 최대 64바이트입니다 (현재 ${bytes}바이트).`);
        if (!/^[0-9.]+$/.test(trimmed)) {
          pushError(`${prefix}UID는 숫자(0-9)와 점(.)만 허용됩니다.`);
        } else if (trimmed.startsWith('.') || trimmed.endsWith('.') || trimmed.includes('..')) {
          pushError(`${prefix}UID의 시작/끝에 점(.)이 있거나 연속 점(..)이 있습니다.`);
        } else if (trimmed.split('.').some((seg) => seg.length > 1 && seg.startsWith('0'))) {
          pushWarn(`${prefix}표준 UID 세그먼트는 0으로 시작하지 않는 것이 권장됩니다.`);
        }
        break;
      }
      case 'PN': {
        const groups = part.split('=');
        if (groups.length > 3) {
          pushError(`${prefix}PN은 최대 3개 문자그룹(=)만 허용됩니다.`);
        }
        groups.forEach((g, gi) => {
          if (g.length > 64) {
            pushError(`${prefix}문자그룹 #${gi + 1}이 64자를 초과했습니다 (${g.length}자).`);
          }
          if (g.split('^').length > 5) {
            pushWarn(`${prefix}문자그룹 #${gi + 1}의 구성요소(^)가 표준 5개를 초과했습니다.`);
          }
        });
        break;
      }
      case 'SH':
      case 'LO':
      case 'ST':
      case 'LT': {
        if (spec.maxLength && part.length > spec.maxLength) {
          pushError(`${prefix}최대 ${spec.maxLength}자 초과 (현재 ${part.length}자)`);
        }
        break;
      }
      case 'US':
      case 'SS':
      case 'UL':
      case 'SL': {
        const trimmed = part.trim();
        if (!/^[+-]?\d+$/.test(trimmed)) {
          pushError(`${prefix}정수만 입력 가능합니다.`);
        } else {
          const n = Number(trimmed);
          const ranges = {
            US: [0, 65535],
            SS: [-32768, 32767],
            UL: [0, 4294967295],
            SL: [-2147483648, 2147483647],
          };
          const [min, max] = ranges[vr];
          if (n < min || n > max) {
            pushError(`${prefix}${vr} 범위 초과 (${min} ~ ${max})`);
          }
        }
        break;
      }
      case 'SV':
      case 'UV': {
        const trimmed = part.trim();
        if (!/^[+-]?\d+$/.test(trimmed)) {
          pushError(`${prefix}64-bit 정수만 입력 가능합니다.`);
        } else if (vr === 'UV' && trimmed.startsWith('-')) {
          pushError(`${prefix}UV는 음수를 허용하지 않습니다.`);
        }
        break;
      }
      case 'FL':
      case 'FD': {
        const trimmed = part.trim();
        if (trimmed === '' || Number.isNaN(Number(trimmed))) {
          pushError(`${prefix}유효한 실수 값이 아닙니다.`);
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    valid: severity !== 'error',
    severity,
    messages,
  };
}
