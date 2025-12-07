import React, { useState } from 'react';
import { generateSSHCommand, explainLog } from '../infrastructure/services/geminiService';
import { Sparkles, MessageSquare, Copy, Terminal, Check } from 'lucide-react';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { Card, CardContent } from './ui/card';
import { Label } from './ui/label';

const AssistantPanel: React.FC = () => {
  const [prompt, setPrompt] = useState('');
  const [response, setResponse] = useState('');
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'command' | 'explain'>('command');
  const [copied, setCopied] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;

    setLoading(true);
    setResponse('');
    
    try {
      if (mode === 'command') {
        const cmd = await generateSSHCommand(prompt);
        setResponse(cmd);
      } else {
        const explanation = await explainLog(prompt);
        setResponse(explanation);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(response);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="h-full flex flex-col glass-panel border-l border-border/70 w-80 z-20">
      <div className="p-4 border-b border-border/70 bg-gradient-to-r from-primary/10 to-transparent">
        <h2 className="text-foreground font-semibold flex items-center gap-2">
          <Sparkles className="text-primary" size={18} />
          netcatty AI
        </h2>
        <p className="text-xs text-muted-foreground mt-1">Generate commands or debug logs</p>
      </div>

      <div className="p-4 grid grid-cols-2 gap-2">
        <Button
          variant={mode === 'command' ? "default" : "outline"}
          size="sm"
          onClick={() => setMode('command')}
        >
          Generate
        </Button>
        <Button
          variant={mode === 'explain' ? "default" : "outline"}
          size="sm"
          onClick={() => setMode('explain')}
        >
          Explain
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-2">
            <Label className="uppercase text-xs text-muted-foreground">
              {mode === 'command' ? 'Describe Task' : 'Paste Log/Error'}
            </Label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="h-32 resize-none font-mono text-sm"
              placeholder={mode === 'command' ? "e.g. Find all files larger than 50MB in /var/log" : "e.g. Error: Connection refused on port 22"}
            />
          </div>
          
          <Button
            type="submit"
            disabled={loading}
            className="w-full"
          >
            {loading ? <div className="animate-spin w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full" /> : <Sparkles size={14} className="mr-2" />}
            {mode === 'command' ? 'Generate' : 'Analyze'}
          </Button>
        </form>

        {response && (
          <div className="mt-6 animate-fade-in">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Result</span>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleCopy}>
                {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
              </Button>
            </div>
            <Card className="bg-muted/50 border-border">
                <CardContent className="p-3">
                  <pre className="text-sm font-mono whitespace-pre-wrap break-words text-foreground">
                    {response}
                  </pre>
                </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
};

export default AssistantPanel;
