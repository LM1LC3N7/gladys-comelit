# Comelit (SimpleHome, Vedo, interphone) pour Gladys

Cette intégration relie une installation **Comelit** à Gladys Assistant,
**en local** sur votre réseau, sans passer par le cloud Comelit :

- le pont **SimpleHome** (Serial Bridge) : lumières, prises, volets,
  thermostats ;
- l'alarme **Vedo**, par le pont ou sur une Vedo IP à part ;
- en option, les **portes et portails** du pont de l'interphone.

> **Jamais testé avec un vrai pont.** Le protocole vient de la bibliothèque
> [aiocomelit](https://github.com/chemelli74/aiocomelit) 3.0.0 (celle de
> l'intégration Comelit de Home Assistant) et, pour les portes, de
> [comelit-client](https://github.com/madchicken/comelit-client), portés en
> JavaScript et vérifiés seulement contre un pont simulé. Faites vos premiers
> essais en présence, alarme désarmée, et signalez ce qui ne va pas.
>
> Intégration non officielle, sans lien avec Comelit Group.

## Ce que vous obtenez

- **Pont Comelit** : connecté ou non.
- **Lumières** (allumer, éteindre) et **prises** (marche, arrêt), avec leur
  état. Les « prises » sont **tous les objets « autres »** (`other`) du pont,
  publiés comme interrupteurs : ils obéissent aux « tout éteindre » des
  assistants vocaux et des scènes. Une sortie « autre » peut piloter un
  portail, une pompe ou une chaudière : vérifiez ce qu'il y a derrière chacune
  avant de les créer dans Gladys.
- **Volets** : ouvrir, fermer, arrêter (une fonction « volet », jamais un
  interrupteur). Le pont ne donne pas la position, seulement le mouvement.
- **Thermostats** : température mesurée et **consigne**. Régler la consigne
  est **désactivé par défaut** (option « Autoriser le réglage des
  thermostats »).
- **Alarme Vedo**, un appareil par secteur (nom repris de la Vedo) :
  - **État** en lecture seule : désarmé, armé (partiel P1, P2, P1 + P2, total),
    armement en cours, délai d'entrée ;
  - **Alarme en cours** et **Sabotage** ;
  - des **boutons** : armement total, armement partiel P1, armement partiel
    P1 + P2 (si le secteur a un P2), désarmer.
- **Zones** de l'alarme, une par appareil : ouverte ou fermée (ou mouvement,
  fumée, fuite selon le type choisi), alarme, exclue, sabotage.
- **Portes de l'interphone** : un **bouton** « Ouvrir » par porte.
- **Déclencheurs de scène** : alarme déclenchée (avec la première zone en
  alarme), secteur armé (mode, demandé par Gladys ou non), secteur désarmé.

Aucune commande d'alarme ni de porte n'est un interrupteur : un « éteins
tout » d'un assistant vocal, de HomeKit ou d'une scène ne peut ni désarmer,
ni ouvrir une porte. Les états sont en lecture seule, les commandes sont des
boutons.

## Configuration

1. **Adresse du pont** : l'adresse IP du pont SimpleHome. Donnez-lui une
   adresse fixe dans votre box. Vide si vous n'avez qu'une Vedo IP.
2. **Port du pont** : 80, sauf changement.
3. **Code (PIN) du pont** : celui de la page web du pont, s'il en a un.
4. **Code de l'alarme** : un code utilisateur de la Vedo. Sans lui,
   l'alarme n'est pas lue.
5. **Adresse de la Vedo IP** : seulement si votre Vedo a son propre module
   réseau. Vide : l'alarme est lue par le pont.
6. **Type des zones** (facultatif), numérotées à partir de 1 comme dans
   l'application Comelit, par exemple `2:motion, 5:smoke, 7-9:motion`. Types :
   `opening` (ouverture, par défaut), `motion` (mouvement), `smoke` (fumée),
   `leak` (fuite d'eau). Changer le type d'une zone déjà créée ajoute une
   nouvelle fonction et garde l'ancienne (et son historique).
7. **Interphone** (facultatif) : adresse du pont de l'interphone, port
   (64100) et **jeton utilisateur** (voir plus bas).
8. **Intervalle de lecture** : 10 secondes par défaut (5 à 300). Le pont
   n'envoie rien de lui-même : un changement fait au clavier ou dans
   l'application Comelit apparaît dans ce délai.
9. **Sécurité** : voir plus bas.
10. **Langue des noms** : français ou anglais.

Les codes et le jeton sont des **champs secrets** : gardés par Gladys dans sa
base, jamais réaffichés dans l'interface, envoyés seulement au pont, à la
Vedo ou au pont de l'interphone. Ils n'apparaissent jamais dans les journaux
ni dans `/data`. Attention : le pont et la Vedo ne parlent que HTTP, sans
protection, et le protocole de l'interphone non plus : **ils circulent en
clair sur votre réseau local**, comme le cookie de session que le pont donne
après la connexion (qui le lit peut piloter le pont tant que la session
dure). Protégez votre réseau (Wi-Fi invité séparé
pour les appareils dont vous n'êtes pas sûr).

Le bouton **Tester la connexion** relance ce qui est arrêté (code refusé
compris), attend les connexions et indique ce qui a été trouvé.

## Sécurité

- **Armer est désactivé par défaut**, **désarmer aussi** : deux options
  séparées. Une fois « Autoriser le désarmement » cochée, **tout utilisateur
  de Gladys, toute scène et l'application mobile Gladys peuvent désarmer sans
  taper de code** : le code de la configuration suffit. Ne l'autorisez que si
  votre Gladys est bien protégé. Désarmer coupe aussi une alarme en cours.
- **Régler un thermostat est désactivé par défaut.** La consigne va de 5 à
  30 °C ; elle est refusée si le thermostat est éteint ou en mode automatique
  (son programme fixe la consigne).
- Les options sont relues à l'arrivée de la commande, dans la file, après la
  relecture de l'état et juste avant l'envoi : une option décochée pendant
  qu'une commande attend son tour bloque cette commande.
- Avant chaque commande d'alarme, de thermostat ou d'arrêt de volet,
  l'intégration **relit l'état sur le pont** et décide sur cet état, jamais
  sur ce qu'elle a en mémoire. Les commandes passent une par une.
- L'armement n'est jamais forcé : un secteur que la Vedo refuse d'armer tel
  quel (zone ouverte, anomalie) reste désarmé.
- Une commande qui ne peut pas partir dans les temps (pont lent, état
  illisible) est refusée avec « rien n'a été envoyé ». Une commande partie
  sans réponse claire (pas de réponse, réponse inattendue) est annoncée
  « envoyée, sans confirmation » et l'état est relu : elle n'est jamais
  annoncée « non envoyée ». Seul un refus net du pont (HTTP 4xx) est annoncé
  « refusé ».
- Pour l'alarme, la réponse HTTP ne prouve rien : l'ancien micrologiciel de
  la Vedo répond 200 et le nouveau 404 à chaque action (aiocomelit le note).
  L'intégration relit donc l'état aussitôt et n'annonce la réussite que si
  l'état lu **a changé** et montre le résultat (désarmé : plus d'alarme ni de
  délai en cours) ; sinon « envoyée, sans confirmation ».
- Plusieurs commandes de volets ou de thermostats arrivées ensemble (« tout
  fermer ») partagent une même relecture, faite après leur arrivée, tant
  qu'aucune commande n'est partie vers ce volet depuis. Les appels au pont
  s'enchaînent sans pause ; seuls les appels à la Vedo gardent 250 ms entre
  eux, et les thermostats 1,5 s, comme aiocomelit.
- Pendant un « tout fermer », un volet qui est en train de s'ouvrir est
  refusé (la commande l'arrêterait au lieu de le fermer) : relancez-le une
  fois arrêté.
- Arrêter un volet envoie la commande du sens inverse (c'est ainsi que le
  pont arrête un volet) ; aucun second arrêt ne part tant que le pont ne
  montre pas le volet arrêté (15 s au plus), sinon il repartirait dans
  l'autre sens ; ouvrir ou fermer ce volet est aussi refusé pendant ce temps.
  Ouvrir un volet qui se ferme (ou l'inverse) est refusé : arrêtez-le
  d'abord.
- Chaque commande, envoyée ou refusée, est écrite dans les journaux de
  l'intégration.

## Portes de l'interphone

**L'ouverture de porte est désactivée par défaut, et le protocole utilisé
est mal connu : son auteur le dit « très alpha ». Une fois l'option cochée,
tout utilisateur de Gladys, toute scène et l'application mobile Gladys
peuvent ouvrir vos portes et portails, et rien ne confirme que la porte s'est
ouverte. Ne l'activez que si vous acceptez ce risque, et testez en présence.**

- Il faut le **jeton utilisateur** de l'application Comelit : voir le
  [guide de comelit-client](https://github.com/madchicken/comelit-client/wiki/Get-your-user-token-for-ICONA-communication).
  Ce jeton ouvre vos portes : traitez-le comme une clé.
- Les portes sont lues dans le carnet d'adresses du pont de l'interphone
  (« opendoor »). Les actionneurs et les entrées ne sont pas pris en charge
  dans cette version.
- Chaque ouverture ouvre une courte connexion et relit la configuration du
  pont : la porte doit y être, avec la même adresse et la même sortie qu'à la
  découverte (gardées dans les paramètres de l'appareil). Sinon : refus
  « configuration de l'interphone changée, relancez une recherche », aucune
  trame, et les portes sont relues. L'intégration vérifie ensuite l'option et
  le délai juste avant la première trame d'ouverture, puis écrit les trames
  de comelit-client.
- Le pont ne donne aucune confirmation : **Gladys répond toujours « envoyée,
  sans confirmation »**, même quand toutes les trames sont parties.
- Une porte n'est pas rouverte depuis Gladys dans les 10 secondes.
- Si le pont refuse le jeton, l'interphone s'arrête et ne réessaie pas tout
  seul.

## Connexion et code refusé

- **Une seule session vers le pont** : une requête à la fois, les commandes
  avant les lectures, 250 ms au moins entre deux appels à la Vedo.
- Sur une coupure, les nouveaux essais sont espacés : 10 s, 30 s, 1 min,
  2 min, puis toutes les 5 minutes.
- **Si le pont refuse son code, l'intégration s'arrête** et ne réessaie pas
  toute seule, même après un redémarrage (un code faux essayé en boucle
  pourrait bloquer l'appareil). Pareil pour le code de l'alarme (l'alarme
  seule s'arrête, les lumières continuent) et pour le jeton de l'interphone.
  Corrigez le code puis enregistrez, ou cliquez sur « Tester la connexion ».
  Le fichier `/data/comelit-state.json` garde seulement l'adresse concernée,
  jamais le code.
- Un refus se reconnaît à une réponse HTTP 401 ou 403 à l'envoi du code, à
  une réponse sans cookie de session, ou à une session toujours absente
  1,5 s après : un pont lent à ouvrir la session
  peut donc être pris pour un refus (l'intégration s'arrête alors, sans
  boucle ; « Tester la connexion » relance).

## Limites connues

- Jamais testé avec un vrai pont (voir plus haut).
- Lecture par intervalle : le pont n'envoie pas les changements.
- Volets : pas de position, seulement ouvrir, fermer, arrêter.
- Thermostats : seulement la température et la consigne (pas le mode, pas
  l'humidité) ; un appareil qui n'est qu'un déshumidificateur n'est pas
  repris.
- Arrosage et scénarios du pont : pas pris en charge.
- Les zones ne disent pas à quel secteur elles appartiennent : la zone donnée
  avec « alarme déclenchée » est la première zone en alarme.
- Une alarme déjà en cours au démarrage ne déclenche pas de scène (seuls les
  changements vus le font).

## Confidentialité

Tout reste sur votre réseau : l'intégration ne parle qu'au pont, à la Vedo et
au pont de l'interphone.

## Licence

Apache-2.0. Logique portée d'aiocomelit et de comelit-client (Apache-2.0) :
voir `THIRD_PARTY_NOTICES.md`.
