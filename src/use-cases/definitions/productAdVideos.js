export const productAdVideosUseCase = {
  useCaseId: "product-ad-videos",
  label: "Product Ad Videos",
  description: "Generate high-converting cinematic product ad video clips",
  category: "advertising",
  type: "flow",
  thumbnail: "/thumbnails/product-ad-videos.jpg",
  status: "active",
  workflowRef: "product-ad-videos-v1",
  billing: {
    strategy: "per-node",
  },
  inputSchema: {
    product_name: {
      type: "string",
      required: true,
      label: "Product Name",
      placeholder: "e.g. CleanSuds Soap"
    },
    description: {
      type: "string",
      required: true,
      label: "Product Description",
      placeholder: "e.g. organic lavender oil moisturizing soap bar"
    },
    duration: {
      type: "number",
      default: 5,
      min: 3,
      max: 15,
      label: "Video Duration (seconds)"
    }
  },
  version: "1.0.0",
  author: "system",
  tags: ["product", "ads", "video"],
  visibility: "public"
};
