/**
 * The languages of the Code tab, in the order they are offered: what the page may ask for, with the name shown and the language the viewer
 * colours. The code that writes each is in src/codegen/ (a test checks that the two lists are the same).
 */
export interface CodeLanguage {
  id: string;
  label: string;
  /** What the viewer of the page colours it as; "text" has no colours. */
  highlight: 'js' | 'text';
}

export const CODE_LANGUAGES: readonly CodeLanguage[] = [
  { id: 'curl', label: 'cURL', highlight: 'text' },
  { id: 'powershell', label: 'PowerShell', highlight: 'text' },
  { id: 'fetch', label: 'JavaScript (fetch)', highlight: 'js' },
  { id: 'axios', label: 'JavaScript (axios)', highlight: 'js' },
  { id: 'python', label: 'Python (requests)', highlight: 'text' },
  { id: 'go', label: 'Go (net/http)', highlight: 'text' },
  { id: 'csharp', label: 'C# (HttpClient)', highlight: 'text' },
  { id: 'php', label: 'PHP (cURL)', highlight: 'text' },
  { id: 'java', label: 'Java (HttpClient)', highlight: 'text' }
];

export const CODE_LANGUAGE_IDS: readonly string[] = CODE_LANGUAGES.map(language => language.id);
