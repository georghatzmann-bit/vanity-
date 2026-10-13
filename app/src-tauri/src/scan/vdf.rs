//! Kleiner, fehlertoleranter Parser für Valves Text-KeyValues (VDF/ACF).
//!
//! ```text
//! "AppState"
//! {
//!     "appid"   "570"
//!     "name"    "Dota 2"
//! }
//! ```

/// Ein Knoten: Text oder Objekt (Reihenfolge und doppelte Schlüssel bleiben erhalten).
#[derive(Debug, Clone, PartialEq)]
pub enum Vdf {
    Str(String),
    Obj(Vec<(String, Vdf)>),
}

impl Vdf {
    /// Kind-Element (Schlüssel ohne Beachtung der Groß-/Kleinschreibung).
    pub fn get(&self, key: &str) -> Option<&Vdf> {
        match self {
            Vdf::Obj(items) => items
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(key))
                .map(|(_, v)| v),
            Vdf::Str(_) => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Vdf::Str(s) => Some(s),
            Vdf::Obj(_) => None,
        }
    }

    /// Text eines Kind-Elements.
    pub fn get_str(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(|v| v.as_str())
    }

    /// Alle Einträge eines Objekts (leer für Texte).
    pub fn entries(&self) -> &[(String, Vdf)] {
        match self {
            Vdf::Obj(items) => items,
            Vdf::Str(_) => &[],
        }
    }
}

#[derive(Debug, PartialEq)]
enum Token {
    Open,
    Close,
    Text(String),
}

fn tokenize(input: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut chars = input.trim_start_matches('\u{feff}').chars().peekable();
    while let Some(&c) = chars.peek() {
        match c {
            c if c.is_whitespace() => {
                chars.next();
            }
            '/' => {
                chars.next();
                if chars.peek() == Some(&'/') {
                    // Kommentar bis Zeilenende
                    for c in chars.by_ref() {
                        if c == '\n' {
                            break;
                        }
                    }
                } else {
                    // einzelnes '/' als Teil eines Wortes behandeln
                    let mut word = String::from("/");
                    while let Some(&c) = chars.peek() {
                        if c.is_whitespace() || c == '{' || c == '}' || c == '"' {
                            break;
                        }
                        word.push(c);
                        chars.next();
                    }
                    tokens.push(Token::Text(word));
                }
            }
            '{' => {
                chars.next();
                tokens.push(Token::Open);
            }
            '}' => {
                chars.next();
                tokens.push(Token::Close);
            }
            '"' => {
                chars.next();
                let mut s = String::new();
                while let Some(c) = chars.next() {
                    match c {
                        '"' => break,
                        '\\' => match chars.peek().copied() {
                            Some('\\') => {
                                s.push('\\');
                                chars.next();
                            }
                            Some('"') => {
                                s.push('"');
                                chars.next();
                            }
                            Some('n') => {
                                s.push('\n');
                                chars.next();
                            }
                            Some('t') => {
                                s.push('\t');
                                chars.next();
                            }
                            // Unbekannte Folge (z. B. unmaskierter Windows-Pfad): Backslash behalten
                            _ => s.push('\\'),
                        },
                        c => s.push(c),
                    }
                }
                tokens.push(Token::Text(s));
            }
            '[' => {
                // Bedingungen wie [$WIN32] überspringen
                for c in chars.by_ref() {
                    if c == ']' || c == '\n' {
                        break;
                    }
                }
            }
            _ => {
                let mut word = String::new();
                while let Some(&c) = chars.peek() {
                    if c.is_whitespace() || c == '{' || c == '}' || c == '"' {
                        break;
                    }
                    word.push(c);
                    chars.next();
                }
                tokens.push(Token::Text(word));
            }
        }
    }
    tokens
}

fn parse_object(tokens: &mut std::iter::Peekable<std::vec::IntoIter<Token>>) -> Vec<(String, Vdf)> {
    let mut items = Vec::new();
    while let Some(tok) = tokens.next() {
        match tok {
            Token::Close => break,
            Token::Open => {
                // Objekt ohne Schlüssel – Inhalt übernehmen
                let inner = parse_object(tokens);
                items.extend(inner);
            }
            Token::Text(key) => match tokens.peek() {
                Some(Token::Open) => {
                    tokens.next();
                    let inner = parse_object(tokens);
                    items.push((key, Vdf::Obj(inner)));
                }
                Some(Token::Text(_)) => {
                    if let Some(Token::Text(v)) = tokens.next() {
                        items.push((key, Vdf::Str(v)));
                    }
                }
                Some(Token::Close) | None => {
                    items.push((key, Vdf::Str(String::new())));
                }
            },
        }
    }
    items
}

/// VDF-Text einlesen. Fehlerhafte Stellen werden so gut wie möglich übersprungen.
pub fn parse(input: &str) -> Vdf {
    let mut tokens = tokenize(input).into_iter().peekable();
    let mut items = Vec::new();
    while tokens.peek().is_some() {
        items.extend(parse_object(&mut tokens));
    }
    Vdf::Obj(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_acf() {
        let text = r#"
"AppState"
{
	"appid"		"1245620"
	"Universe"		"1"
	"name"		"ELDEN RING"
	"StateFlags"		"4"
	"installdir"		"ELDEN RING"
	"UserConfig"
	{
		"language"		"german"
	}
}
"#;
        let v = parse(text);
        let app = v.get("appstate").unwrap();
        assert_eq!(app.get_str("appid"), Some("1245620"));
        assert_eq!(app.get_str("NAME"), Some("ELDEN RING"));
        assert_eq!(app.get("UserConfig").unwrap().get_str("language"), Some("german"));
    }

    #[test]
    fn escapes_comments_and_conditions() {
        let text = "// Kommentar\n\"root\" { \"path\" \"C:\\\\Program Files (x86)\\\\Steam\" \"q\" \"a \\\"b\\\"\" \"raw\" \"D:\\Games\" \"cond\" \"1\" [$WIN32] unquoted value }";
        let v = parse(text);
        let r = v.get("root").unwrap();
        assert_eq!(r.get_str("path"), Some(r"C:\Program Files (x86)\Steam"));
        assert_eq!(r.get_str("q"), Some("a \"b\""));
        assert_eq!(r.get_str("raw"), Some(r"D:\Games"));
        assert_eq!(r.get_str("cond"), Some("1"));
        assert_eq!(r.get_str("unquoted"), Some("value"));
    }

    #[test]
    fn tolerates_broken_input() {
        let v = parse("\"a\" { \"b\" \"c\" \"d\" { \"e\" ");
        let a = v.get("a").unwrap();
        assert_eq!(a.get_str("b"), Some("c"));
        assert_eq!(a.get("d").unwrap().get_str("e"), Some(""));
        assert_eq!(parse(""), Vdf::Obj(vec![]));
        assert_eq!(parse("}}}{{"), Vdf::Obj(vec![]));
    }
}
