# Priora — imagem de produção com Playwright.
# A imagem oficial do Playwright já traz o Chromium (build 1194, que casa com o
# playwright 1.56.1) e TODAS as bibliotecas de sistema do navegador — é o que
# falta no runtime nativo do Render para os scrapers de demurrage rodarem.
FROM mcr.microsoft.com/playwright:v1.56.1-noble

WORKDIR /app

ENV NODE_ENV=production
# A imagem já tem o browser em /ms-playwright; não baixe de novo no npm ci.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Instala dependências a partir do lockfile (inclui dev para o build TypeScript).
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Copia o código e compila para dist/.
COPY . .
RUN npm run build

# Enxuga a imagem final removendo as devDependencies (ts-node/typescript etc.).
RUN npm prune --omit=dev

EXPOSE 3000
CMD ["npm", "start"]
