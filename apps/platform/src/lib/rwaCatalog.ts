export type IdentityPolicy = {
  minimumAge: 18;
  nationality?: "USA";
};

export type RwaToken = {
  id: string;
  name: string;
  symbol: string;
  assetType: string;
  jurisdiction: string;
  description: string;
  reference: string;
  maturity: string;
  accent: "ocean" | "sun" | "clay" | "ink" | "violet";
  requirements: {
    selfie: boolean;
    identity?: IdentityPolicy;
  };
};

export const RWA_TOKENS: RwaToken[] = [
  {
    id: "lisbon-green-note",
    name: "Lisbon Green Note",
    symbol: "LGN",
    assetType: "Renewable infrastructure",
    jurisdiction: "Portugal",
    description:
      "A demo note backed by a portfolio of rooftop solar installations across Lisbon.",
    reference: "PT-RWA-001",
    maturity: "36 months",
    accent: "ocean",
    requirements: {
      selfie: false,
    },
  },
  {
    id: "solar-continuity-bond",
    name: "Solar Continuity Bond",
    symbol: "SCB",
    assetType: "Energy receivables",
    jurisdiction: "European Union",
    description:
      "A tokenized receivables pool requiring a fresh liveness confirmation before access.",
    reference: "EU-RWA-018",
    maturity: "24 months",
    accent: "sun",
    requirements: {
      selfie: true,
    },
  },
  {
    id: "housing-income-note",
    name: "Housing Income Note",
    symbol: "HIN",
    assetType: "Residential real estate",
    jurisdiction: "European Union",
    description:
      "A fractional demo instrument linked to rental income from student housing assets.",
    reference: "EU-RWA-204",
    maturity: "48 months",
    accent: "clay",
    requirements: {
      selfie: false,
      identity: {
        minimumAge: 18,
      },
    },
  },
  {
    id: "us-treasury-access-note",
    name: "US Treasury Access Note",
    symbol: "UTA",
    assetType: "Government securities",
    jurisdiction: "United States",
    description:
      "A mock short-duration treasury product restricted to adult US nationals.",
    reference: "US-RWA-091",
    maturity: "12 months",
    accent: "ink",
    requirements: {
      selfie: false,
      identity: {
        minimumAge: 18,
        nationality: "USA",
      },
    },
  },
  {
    id: "american-property-fund",
    name: "American Property Fund",
    symbol: "APF",
    assetType: "Commercial real estate",
    jurisdiction: "United States",
    description:
      "A gated demo fund combining a live selfie check with document-backed eligibility.",
    reference: "US-RWA-312",
    maturity: "60 months",
    accent: "violet",
    requirements: {
      selfie: true,
      identity: {
        minimumAge: 18,
        nationality: "USA",
      },
    },
  },
];
