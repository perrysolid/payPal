// SAMPLE DATA. Every relief partner, payout email and household below is fictional.
// Relief partners are placeholders, not real NGOs, and have no affiliation with any
// government body. Households are not real beneficiaries.

// Candidate coordinates are probed at runtime against the Open-Meteo flood API.
// Open-Meteo snaps to the nearest GloFAS river cell, so city centres can land on a
// minor tributary. Candidates were chosen along the main channel near each district.

const RAW = [
  {
    id: 'guwahati',
    name: 'Guwahati (Kamrup Metro)',
    shortName: 'Guwahati',
    region: 'Assam',
    country: 'India',
    river: 'Brahmaputra',
    basin: 'Brahmaputra',
    lat: 26.18,
    lon: 91.7,
    candidates: [[26.18, 91.7], [26.18, 91.6], [26.18, 91.5], [26.28, 91.9]],
    language: { code: 'as', name: 'Assamese', script: 'Bengali-Assamese' },
    referenceBaselineM3s: 5100,
    threshold: 1.8,
    partner: { name: 'Kamrup Riverside Relief Collective', email: 'relief-guwahati@floodgate-sample.example' },
    households: [
      ['Baruah', 5, 'A'], ['Kalita', 4, 'A'], ['Das', 6, 'A'], ['Bora', 3, 'A'],
      ['Saikia', 4, 'B'], ['Deka', 5, 'B'], ['Medhi', 2, 'B'], ['Choudhury', 4, 'B'],
      ['Sarma', 3, 'C'], ['Talukdar', 5, 'C'], ['Gogoi', 4, 'C'], ['Hazarika', 2, 'C'],
    ],
  },
  {
    id: 'majuli',
    name: 'Majuli',
    shortName: 'Majuli',
    region: 'Assam',
    country: 'India',
    river: 'Brahmaputra',
    basin: 'Brahmaputra',
    lat: 26.92,
    lon: 94.18,
    candidates: [[26.92, 94.18], [26.92, 94.28], [26.95, 94.17]],
    language: { code: 'as', name: 'Assamese', script: 'Bengali-Assamese' },
    referenceBaselineM3s: 3180,
    threshold: 1.8,
    partner: { name: 'Majuli Island Mutual Aid Network', email: 'relief-majuli@floodgate-sample.example' },
    households: [
      ['Pegu', 6, 'A'], ['Doley', 5, 'A'], ['Mili', 4, 'A'], ['Payeng', 7, 'A'],
      ['Kutum', 3, 'B'], ['Taid', 5, 'B'], ['Regon', 4, 'B'], ['Bori', 3, 'B'],
      ['Gogoi', 4, 'C'], ['Dutta', 2, 'C'], ['Bhuyan', 5, 'C'], ['Pait', 3, 'C'],
    ],
  },
  {
    id: 'sylhet',
    name: 'Sylhet',
    shortName: 'Sylhet',
    region: 'Sylhet Division',
    country: 'Bangladesh',
    river: 'Surma',
    basin: 'Surma-Meghna',
    lat: 24.89,
    lon: 91.87,
    candidates: [[24.69, 91.77], [24.69, 91.87], [24.89, 91.87], [24.89, 92.07]],
    language: { code: 'bn', name: 'Bengali', script: 'Bengali' },
    referenceBaselineM3s: 1350,
    threshold: 1.8,
    partner: { name: 'Surma Valley Community Relief Trust', email: 'relief-sylhet@floodgate-sample.example' },
    households: [
      ['Ahmed', 6, 'A'], ['Begum', 4, 'A'], ['Hossain', 5, 'A'], ['Uddin', 7, 'A'],
      ['Chowdhury', 4, 'B'], ['Rahman', 3, 'B'], ['Khatun', 5, 'B'], ['Miah', 4, 'B'],
      ['Islam', 3, 'C'], ['Akter', 2, 'C'], ['Das', 4, 'C'], ['Paul', 3, 'C'],
    ],
  },
  {
    id: 'kurigram',
    name: 'Kurigram',
    shortName: 'Kurigram',
    region: 'Rangpur Division',
    country: 'Bangladesh',
    river: 'Brahmaputra-Jamuna',
    basin: 'Brahmaputra-Jamuna',
    lat: 25.6,
    lon: 89.68,
    candidates: [[25.6, 89.68], [25.5, 89.68], [25.7, 89.78]],
    language: { code: 'bn', name: 'Bengali', script: 'Bengali' },
    referenceBaselineM3s: 6700,
    threshold: 1.8,
    partner: { name: 'Char Lands Relief Cooperative', email: 'relief-kurigram@floodgate-sample.example' },
    households: [
      ['Sarkar', 5, 'A'], ['Mondal', 6, 'A'], ['Pramanik', 4, 'A'], ['Sheikh', 5, 'A'],
      ['Ali', 3, 'B'], ['Bibi', 4, 'B'], ['Roy', 5, 'B'], ['Barman', 3, 'B'],
      ['Haque', 4, 'C'], ['Karim', 2, 'C'], ['Mia', 3, 'C'], ['Nessa', 4, 'C'],
    ],
  },
  {
    id: 'saptari',
    name: 'Saptari',
    shortName: 'Saptari',
    region: 'Madhesh Province',
    country: 'Nepal',
    river: 'Koshi',
    basin: 'Koshi',
    lat: 26.55,
    lon: 86.93,
    candidates: [[26.55, 86.93], [26.45, 86.83], [26.55, 86.83]],
    language: { code: 'ne', name: 'Nepali', script: 'Devanagari' },
    referenceBaselineM3s: 1490,
    threshold: 1.8,
    partner: { name: 'Koshi Tarai Relief Circle', email: 'relief-saptari@floodgate-sample.example' },
    households: [
      ['Yadav', 6, 'A'], ['Mandal', 5, 'A'], ['Sada', 7, 'A'], ['Mukhiya', 4, 'A'],
      ['Shah', 4, 'B'], ['Chaudhary', 5, 'B'], ['Thakur', 3, 'B'], ['Ram', 4, 'B'],
      ['Jha', 3, 'C'], ['Karna', 4, 'C'], ['Mahato', 5, 'C'], ['Poudel', 2, 'C'],
    ],
  },
  {
    id: 'darbhanga',
    name: 'Darbhanga',
    shortName: 'Darbhanga',
    region: 'Bihar',
    country: 'India',
    river: 'Kosi',
    basin: 'Kosi',
    lat: 26.05,
    lon: 86.45,
    candidates: [[26.05, 86.45], [26.25, 86.55], [25.95, 86.35]],
    language: { code: 'mai', name: 'Maithili', script: 'Devanagari' },
    referenceBaselineM3s: 1510,
    threshold: 1.8,
    partner: { name: 'Mithila Flood Response Volunteers', email: 'relief-darbhanga@floodgate-sample.example' },
    households: [
      ['Mishra', 5, 'A'], ['Paswan', 6, 'A'], ['Sahni', 7, 'A'], ['Mukhiya', 4, 'A'],
      ['Jha', 4, 'B'], ['Yadav', 5, 'B'], ['Kamat', 3, 'B'], ['Choupal', 4, 'B'],
      ['Thakur', 3, 'C'], ['Singh', 4, 'C'], ['Pandit', 2, 'C'], ['Raut', 5, 'C'],
    ],
  },
];

export const ZONE_DESCRIPTIONS = {
  A: 'Zone A: riverbank and low-lying char land, first to flood',
  B: 'Zone B: embankment-adjacent settlements, flood within 24-48h of peak',
  C: 'Zone C: higher ground, affected by prolonged inundation and access loss',
};

export function buildDistricts() {
  return RAW.map((d) => ({
    ...d,
    sample: true,
    households: d.households.map(([surname, members, zone], i) => ({
      id: `${d.id}-hh-${String(i + 1).padStart(2, '0')}`,
      label: `${surname} household`,
      members,
      zone,
      sample: true,
    })),
  }));
}

export const DISTRICT_IDS = RAW.map((d) => d.id);
