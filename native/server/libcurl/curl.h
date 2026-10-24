// VANITY: Ersatz fuer libcurl.
//
// Magnesium benutzt curl nur fuer Discord-Webhooks und eine Telemetrie-Funktion. Beides braucht
// Vanity nicht und soll keine Verbindung nach aussen aufbauen. Statt die vielen Aufrufstellen
// zu entfernen, ersetzen wir curl durch No-Op-Funktionen: `curl_easy_init` gibt `nullptr`, also
// steigt jede echte Sende-Funktion sofort wieder aus. Nichts wird gesendet, nichts wird gelinkt.
//
// Ersetzt das urspruengliche libcurl/curl.h (BSD/MIT, Daniel Stenberg) vollstaendig.
#pragma once
#include <cstddef>

typedef void CURL;
typedef int CURLcode;
typedef int CURLoption;
typedef int CURLINFO;
typedef long long curl_off_t;

struct curl_slist
{
    char* data;
    curl_slist* next;
};

enum
{
    CURLE_OK = 0,
};

enum
{
    CURL_GLOBAL_ALL = 3,
};

// Optionen und Infos – die konkreten Werte sind egal, da nichts ausgefuehrt wird.
enum
{
    CURLOPT_URL = 10002,
    CURLOPT_HTTPHEADER = 10023,
    CURLOPT_POSTFIELDS = 10015,
    CURLOPT_POSTFIELDSIZE_LARGE = 30120,
    CURLOPT_POST = 47,
    CURLOPT_USERAGENT = 10018,
    CURLOPT_NOSIGNAL = 99,
    CURLOPT_NOPROXY = 10177,
    CURLOPT_FOLLOWLOCATION = 52,
    CURLOPT_TCP_KEEPALIVE = 213,
    CURLOPT_CONNECTTIMEOUT_MS = 156,
    CURLOPT_TIMEOUT_MS = 155,
    CURLOPT_WRITEDATA = 10001,
    CURLOPT_WRITEFUNCTION = 20011,
    CURLINFO_RESPONSE_CODE = 2097154,
};

inline CURL* curl_easy_init() { return nullptr; }
inline CURLcode curl_easy_setopt(CURL*, CURLoption, ...) { return CURLE_OK; }
inline CURLcode curl_easy_getinfo(CURL*, CURLINFO, ...) { return CURLE_OK; }
inline CURLcode curl_easy_perform(CURL*) { return CURLE_OK; }
inline void curl_easy_cleanup(CURL*) {}
inline CURLcode curl_global_init(long) { return CURLE_OK; }
inline curl_slist* curl_slist_append(curl_slist*, const char*) { return nullptr; }
inline void curl_slist_free_all(curl_slist*) {}
