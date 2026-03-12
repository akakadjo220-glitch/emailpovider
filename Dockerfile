# Setup optimal pour Coolify / Docker
FROM node:20-alpine

# Crée le dossier app
WORKDIR /app

# Copie les fichiers de dépendances
COPY package*.json ./

# Installe les dépendances de prod
RUN npm install --production

# Copie le code source
COPY . .

# Expose le port par défaut (Express écoute sur 3001 ou PORT)
EXPOSE 3001

# Démarre l'app
CMD ["node", "index.js"]
