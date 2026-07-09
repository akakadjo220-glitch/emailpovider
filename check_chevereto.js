#!/usr/bin/env node

/**
 * Script utilitaire autonome : check_chevereto.js
 * usage: node check_chevereto.js <url_du_media> [nom_de_fichier_de_sortie]
 *
 * Ce script vérifie si une image ou une vidéo est disponible sur Chevereto (avec une requête HEAD)
 * et la télécharge localement si elle est valide.
 */

const fs = require('fs');
const path = require('path');

const mediaUrl = process.argv[2];
let outputPath = process.argv[3];

if (!mediaUrl) {
    console.error('❌ Erreur : Veuillez fournir l\'URL du média Chevereto.');
    console.error('Usage : node check_chevereto.js <url_du_media> [nom_de_fichier_de_sortie]');
    process.exit(1);
}

// Nettoyer et décoder l'URL
let parsedUrl;
try {
    parsedUrl = new URL(mediaUrl);
} catch (e) {
    console.error('❌ Erreur : L\'URL fournie n\'est pas valide.');
    process.exit(1);
}

// Extraire le nom de fichier par défaut si aucun chemin de sortie n'est fourni
if (!outputPath) {
    const urlPathname = parsedUrl.pathname;
    const baseName = path.basename(urlPathname) || 'media_telecharge';
    // Éviter d'avoir un nom vide ou juste des extensions bizarres
    outputPath = baseName.includes('.') ? baseName : `${baseName}.jpg`;
}

// Convertir en chemin absolu pour l'enregistrement
const absoluteOutputPath = path.resolve(outputPath);

async function checkAndDownload() {
    try {
        console.log(`🔍 Vérification de la disponibilité de : ${mediaUrl}...`);
        
        // 1. Envoyer une requête HEAD pour vérifier si le fichier existe
        const headResponse = await fetch(mediaUrl, { method: 'HEAD' });
        
        if (!headResponse.ok) {
            console.error(`❌ Média indisponible sur Chevereto (Status: ${headResponse.status} ${headResponse.statusText})`);
            process.exit(1);
        }

        const contentType = headResponse.headers.get('content-type') || 'inconnu';
        const contentLength = headResponse.headers.get('content-length') || 'taille inconnue';
        
        console.log(`✅ Média trouvé !`);
        console.log(`   - Type de contenu : ${contentType}`);
        console.log(`   - Taille : ${contentLength} octets`);
        console.log(`📥 Téléchargement en cours...`);

        // 2. Envoyer une requête GET pour récupérer le fichier
        const getResponse = await fetch(mediaUrl);
        if (!getResponse.ok) {
            console.error(`❌ Échec du téléchargement (Status: ${getResponse.status})`);
            process.exit(1);
        }

        const arrayBuffer = await getResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // 3. Enregistrer le fichier
        fs.writeFileSync(absoluteOutputPath, buffer);
        console.log(`✨ Téléchargement terminé avec succès !`);
        console.log(`💾 Fichier enregistré sous : ${absoluteOutputPath}`);

    } catch (err) {
        console.error('❌ Une erreur est survenue :', err.message);
        process.exit(1);
    }
}

checkAndDownload();
