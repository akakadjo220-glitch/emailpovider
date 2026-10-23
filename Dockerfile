# Setup optimal pour Coolify / Docker
# Node 24 LTS, version corrigée du 21/10/2026 (CVE Brotli/TLS/DNS). Node 20 est en fin
# de vie et ne reçoit plus de correctifs.
FROM node:24.22.1-alpine

# Crée le dossier app
WORKDIR /app

# Copie les fichiers de dépendances
COPY package*.json ./

# Installe les dépendances de prod (versions exactes du package-lock.json)
RUN npm ci --omit=dev && npm cache clean --force

# Copie le code source (voir .dockerignore)
COPY . .

# Le processus ne tourne pas en root dans le conteneur
USER node

# Expose le port par défaut (Express écoute sur 3001 ou PORT)
EXPOSE 3001

# Démarre l'app
CMD ["node", "index.js"]
