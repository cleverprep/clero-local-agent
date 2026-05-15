export default {
  ssr: false,
  devtools: { enabled: false },
  app: {
    baseURL: "./",
    head: {
      title: "Clero Local Agent",
      meta: [{ name: "viewport", content: "width=device-width, initial-scale=1" }]
    }
  },
  css: ["~/assets/main.css"],
  nitro: {
    preset: "static"
  }
};
