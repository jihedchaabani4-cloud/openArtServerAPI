export const brandMascotUseCase = {
  useCaseId: "brand-mascot-ad-series",
  label: "Brand Mascot Ad Series",
  description: "Create a mascot character series for your brand",
  category: "advertising",
  type: "flow",
  thumbnail: "/thumbnails/brand-mascot.jpg",
  status: "active",
  workflowRef: "brand-mascot-v1",
  billing: {
    strategy: "workflow-budget",
  },
  inputSchema: {
    brand_name: {
      type: "string",
      required: true,
      label: "Brand Name",
      placeholder: "e.g. Nike, Starbucks"
    },
    mascot_style: {
      type: "enum",
      required: true,
      label: "Mascot Style",
      options: ["cartoon", "3d", "realistic"]
    },
    count: {
      type: "number",
      default: 4,
      min: 1,
      max: 8,
      label: "Number of Mascot Images"
    }
  },
  version: "1.0.0",
  author: "system",
  tags: ["brand", "mascot", "ads"],
  visibility: "public"
};
