# Priora — imagem de produção com Playwright.
#
# Base Node estável (Debian bookworm) + instalação do Chromium e das
# bibliotecas de sistema pelo PRÓPRIO Playwright. Assim o navegador SEMPRE casa
# com a versão do playwright do package.json (1.56.1 -> Chromium build 1194),
# sem depender de uma tag específica da imagem oficial do Playwright existir.
# `--with-deps` roda apt-get (permitido no build Docker, que executa como root).
FROM node:20-bookworm

WORKDIR /app

ENV NODE_ENV=production

# Dependências a partir do lockfile (inclui dev para o build TypeScript).
# Pula o download do browser no postinstall; ele é instalado no passo seguinte
# junto com as libs do sistema.
COPY package.json package-lock.json ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --include=dev

# Instala o Chromium + bibliotecas de sistema do navegador.
# Vai para o cache do Playwright (/root/.cache/ms-playwright), fora do node_modules.
RUN npx playwright install --with-deps chromium

# Copia o código e compila para dist/.
COPY . .
RUN npm run build

# Enxuga a imagem final removendo as devDependencies (ts-node/typescript etc.).
# O browser já está no cache do Playwright, então não é afetado.
RUN npm prune --omit=dev

EXPOSE 3000
CMD ["npm", "start"]
