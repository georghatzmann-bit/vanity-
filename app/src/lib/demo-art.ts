/**
 * Echte Steam-Bilder für die Beispiel-Spiele der Vorschau (nur Browser-Demo, nie in der echten App).
 * Die echte App lädt diese Bilder selbst: Steam-Shop (auch per Name), Icon aus der .exe, SteamGridDB.
 * Erzeugt aus den öffentlichen Steam-Adressen; Spiele ohne Eintrag zeigen das Ersatz-Cover.
 */
export interface DemoArt {
  cover?: string;
  hero?: string;
  logo?: string;
  icon?: string;
}

export const DEMO_ART: Record<string, DemoArt> = {
  "Elden Ring": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/1245620/library_600x900.jpg?t=1790290043",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/1245620/library_hero.jpg?t=1790290043",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/1245620/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/1245620/2e048bfc2073ca30804ed5b8c454a9ca0e2f98de.ico",
  },
  "Cyberpunk 2077": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/1091500/6399de67cce3cecadce7900e03f6e09ff910a235/library_capsule.jpg?t=1784714077",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/1091500/cf8cec802dc47d0f24b75f9eee135e96812e2652/library_hero.jpg?t=1784714077",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/1091500/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/1091500/6897c3848f3e0350d512f59d5bae174a1e3739f9.ico",
  },
  "Hades II": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/1145350/2ba105370a00877459144db0dd68af5f2d338429/library_capsule.jpg?t=1779901265",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/1145350/2d2e4115cc8ef9a9f64164714a6f18112dd4831a/library_hero.jpg?t=1779901265",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/1145350/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/1145350/e8cd1233d374c647e8e3d7bbaa98a5d399e3f40b.ico",
  },
  "Stardew Valley": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/413150/library_600x900.jpg?t=1786554168",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/413150/library_hero.jpg?t=1786554168",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/413150/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/413150/913064b27b4b25e2c03cbd261a8b03fd67da693c.ico",
  },
  "Forza Horizon 5": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/1551360/library_600x900.jpg?t=1788546569",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/1551360/library_hero.jpg?t=1788546569",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/1551360/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/1551360/cf2cee9ce3d0d8688d0c661e5363aabd1f359c3a.ico",
  },
  "Baldur's Gate 3": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/1086940/library_600x900.jpg?t=1777363040",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/1086940/library_hero.jpg?t=1777363040",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/1086940/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/1086940/ea19a7ce2af83c0240e775d79d3b690751a062c1.ico",
  },
  "Hollow Knight: Silksong": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/1030300/93637c34351160eaa7d7ff0cce69cb4312abb819/library_capsule.jpg?t=1776125736",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/1030300/70d7e70ae2fd0f8a46661d4a425cd84479dc7a61/library_hero.jpg?t=1776125736",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/1030300/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/1030300/28f5a41307a55aa9151db0b4104ac327039d2683.ico",
  },
  "The Witcher 3: Wild Hunt": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/292030/dd1c19c4e41b120ddfa35734cc31f79254c25082/library_capsule.jpg?t=1790845156",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/292030/2dbca4868f3a9912aad6966bb0b6ab2d270f6da6/library_hero.jpg?t=1790845156",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/292030/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/292030/7b52d11edee478d652ef4e7103e00644bed2c74c.ico",
  },
  "Portal 2": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/620/library_600x900.jpg?t=1790187113",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/620/a58588d857b8683f8065e55f97ab82ad8a945c51/library_hero.jpg?t=1790187113",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/620/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/620/25a5a16b2423bf7487ac5340b5b0948cef48c5f8.ico",
  },
  "Celeste": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/504230/library_600x900.jpg?t=1714089525",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/504230/library_hero.jpg?t=1714089525",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/504230/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/504230/fbcf1fbb408b277b7fa0e601a3b87d82b6b2a531.ico",
  },
  "Disco Elysium": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/632470/library_600x900.jpg?t=1780913406",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/632470/9f2529fe9210b7f676bc78b323ef05a48e8eda61/library_hero.jpg?t=1780913406",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/632470/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/632470/58484c34cb3c178e85844621e3d23cdf15e21c05.ico",
  },
  "Counter-Strike 2": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/730/library_600x900.jpg?t=1791824795",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/730/library_hero.jpg?t=1791824795",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/730/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/730/324b323045b09bace182f928f4104dfcd93cb7f3.ico",
  },
  "Red Dead Redemption 2": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/1174180/library_600x900.jpg?t=1759502961",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/1174180/library_hero.jpg?t=1759502961",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/1174180/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/1174180/5bf6edd7efb1110b457da905e7ac696c6c619ed1.ico",
  },
  "Outer Wilds": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/753640/library_600x900.jpg?t=1785424341",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/753640/library_hero.jpg?t=1785424341",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/753640/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/753640/776c33c3fe66b54a132832449bd8b2e17df93593.ico",
  },
  "Factorio": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/427520/library_600x900.jpg?t=1787348817",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/427520/2fcd262bd4bad87bccc539ee1ba14f6e70e62983/library_hero.jpg?t=1787348817",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/427520/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/427520/bcbf4ca8e6be3f0222e257396c8ba7dbc6caca29.ico",
  },
  "Sea of Thieves": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/1172620/library_600x900.jpg?t=1789650456",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/1172620/library_hero.jpg?t=1789650456",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/1172620/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/1172620/ef129f82533775a9ff81b9e3faeb1dd1a862442e.ico",
  },
  "Balatro": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/2379780/library_600x900.jpg?t=1790693638",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/2379780/library_hero.jpg?t=1790693638",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/2379780/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/2379780/47c0208df70705722e161e2eed1a5b481be22968.ico",
  },
  "Death Stranding": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/1850570/library_600x900.jpg?t=1773400635",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/1850570/library_hero.jpg?t=1773400635",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/1850570/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/1850570/924f078a9db6afbd8240da5140c3dc67a2e8d13e.ico",
  },
  "Ori and the Will of the Wisps": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/1057090/library_600x900.jpg?t=1759530749",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/1057090/library_hero.jpg?t=1759530749",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/1057090/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/1057090/0e0bf569e49bb40343cb3ec7dc81c4a0c3d50b1e.ico",
  },
  "It Takes Two": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/1426210/library_600x900.jpg?t=1777395376",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/1426210/library_hero.jpg?t=1777395376",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/1426210/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/1426210/323a899705796f44d4a95c4e22094dd6f28fb442.ico",
  },
  "Satisfactory": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/526870/8968499686cff74b539c70ca1b44d671562d63dc/library_capsule.jpg?t=1791192059",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/526870/library_hero.jpg?t=1791192059",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/526870/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/526870/b830a7fe1880ee85614322be91d9903078708945.ico",
  },
  "OBS Studio": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/1905180/library_600x900.jpg?t=1788207455",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/1905180/library_hero.jpg?t=1788207455",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/1905180/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/1905180/c807ea593df8d2a40cda2b0a934555d70f7581d1.ico",
  },
  "Blender": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/365670/343bf69e91b1ba06c13eb8e064d27bae78954007/library_capsule.jpg?t=1784038423",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/365670/426f3f5bed16b7aa1d7f4112bcca63c95557d7a4/library_hero.jpg?t=1784038423",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/365670/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/365670/430c6cb862d3f297089e0cd2e67e7610079e23c8.ico",
  },
  "Wallpaper Engine": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/431960/library_600x900.jpg?t=1779452230",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/431960/library_hero.jpg?t=1779452230",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/431960/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/431960/5b3bd0d9e5800b933245b5308089a688804787eb.ico",
  },
  "Krita": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/280680/f634206752c89ab146e450678b6c77c38f38824d/library_capsule.jpg?t=1780002261",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/280680/library_hero.jpg?t=1780002261",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/280680/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/280680/081c4aff36918c43b0edfe8e421c9cd313fcb4d3.ico",
  },
  "Aseprite": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/431730/library_600x900.jpg?t=1749680273",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/431730/library_hero.jpg?t=1749680273",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/431730/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/431730/a08332491434a26b15f7557375dba476903f935c.ico",
  },
  "Cities: Skylines II": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/949230/library_600x900.jpg?t=1791468410",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/949230/library_hero.jpg?t=1791468410",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/949230/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/949230/a183d04770e4cc9e6d615ad0f3301609fd23ac9c.ico",
  },
  "Lethal Company": {
    cover: "https://shared.steamstatic.com/store_item_assets/steam/apps/1966720/library_600x900.jpg?t=1775380053",
    hero: "https://shared.steamstatic.com/store_item_assets/steam/apps/1966720/4e1706e418634fb762001498434bc6b0fe2ed40f/library_hero.jpg?t=1775380053",
    logo: "https://shared.steamstatic.com/store_item_assets/steam/apps/1966720/logo.png",
    icon: "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/1966720/80d2453285274e4723c884a671cdd3f8fe2f766f.ico",
  },
};
