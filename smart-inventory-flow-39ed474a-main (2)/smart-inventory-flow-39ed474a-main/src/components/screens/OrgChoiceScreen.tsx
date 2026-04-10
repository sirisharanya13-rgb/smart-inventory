import { useState } from 'react';
import { motion } from 'framer-motion';
import DB, { type Organization } from '@/lib/database';
import { ArrowLeft, Building, Search, ArrowRight, CheckCircle } from 'lucide-react';

interface Props {
  userId: string;
  onSelectOrg: (org: Organization) => void;
  onRegisterNew: () => void;
  onBack: () => void;
}

export default function OrgChoiceScreen({ userId, onSelectOrg, onRegisterNew, onBack }: Props) {
  const [choice, setChoice] = useState<'none' | 'registered' | 'new'>('none');
  const [search, setSearch] = useState('');

  const orgs = DB.findMany<Organization>('businesses');
  const filtered = orgs.filter(o =>
    o.name.toLowerCase().includes(search.toLowerCase()) ||
    o.type?.toLowerCase().includes(search.toLowerCase())
  );

  if (choice === 'none') {
    return (
      <div className="min-h-screen bg-background bg-grid flex items-center justify-center p-5">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-lg">
          <button onClick={onBack}
            className="flex items-center gap-2 text-muted-foreground hover:text-primary text-sm mb-6 transition-colors">
            <ArrowLeft size={16} /> Back
          </button>

          <div className="text-center mb-8">
            <Building size={48} className="text-primary mx-auto mb-4" />
            <h1 className="text-2xl font-black font-display text-foreground mb-2">Organization Setup</h1>
            <p className="text-muted-foreground text-sm">Is your organization already registered in the system?</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => setChoice('registered')}
              className="glass p-6 text-center cursor-pointer border-primary/20 hover:border-primary/50 transition-all glow-box-cyan"
            >
              <CheckCircle size={36} className="text-primary mx-auto mb-3" />
              <h3 className="font-bold text-foreground mb-1">Already Registered</h3>
              <p className="text-xs text-muted-foreground">Find and join your existing organization</p>
            </motion.button>

            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => { setChoice('new'); onRegisterNew(); }}
              className="glass p-6 text-center cursor-pointer border-accent/20 hover:border-accent/50 transition-all glow-box-green"
            >
              <Building size={36} className="text-accent mx-auto mb-3" />
              <h3 className="font-bold text-foreground mb-1">Not Yet Registered</h3>
              <p className="text-xs text-muted-foreground">Register your organization details</p>
            </motion.button>
          </div>
        </motion.div>
      </div>
    );
  }

  // Registered: show org search/list
  return (
    <div className="min-h-screen bg-background bg-grid flex items-center justify-center p-5">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-lg">
        <button onClick={() => setChoice('none')}
          className="flex items-center gap-2 text-muted-foreground hover:text-primary text-sm mb-6 transition-colors">
          <ArrowLeft size={16} /> Back
        </button>

        <h1 className="text-2xl font-black font-display text-foreground text-center mb-2">
          Select Your Organization
        </h1>
        <p className="text-muted-foreground text-center text-sm mb-6">
          Search and select your organization from the list
        </p>

        {/* Search */}
        <div className="relative mb-4">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search organization by name..."
            className="w-full bg-muted/30 border border-border rounded-xl pl-10 pr-4 py-2.5 text-foreground text-sm outline-none focus:border-primary/50 transition-all"
          />
        </div>

        {/* Org list */}
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="glass p-8 text-center">
              <p className="text-muted-foreground text-sm mb-4">
                {orgs.length === 0 ? 'No organizations registered yet.' : 'No results found.'}
              </p>
              <button onClick={() => { setChoice('new'); onRegisterNew(); }}
                className="text-primary text-sm font-bold hover:underline flex items-center gap-1 mx-auto">
                Register New Organization <ArrowRight size={14} />
              </button>
            </div>
          ) : (
            filtered.map(org => (
              <motion.button
                key={org.id}
                whileHover={{ scale: 1.01 }}
                onClick={() => onSelectOrg(org)}
                className="w-full glass p-4 text-left cursor-pointer hover:border-primary/40 transition-all flex items-center justify-between"
              >
                <div>
                  <h3 className="font-bold text-foreground text-sm">{org.name}</h3>
                  <p className="text-xs text-muted-foreground">{org.type} • {org.address}</p>
                </div>
                <ArrowRight size={16} className="text-primary" />
              </motion.button>
            ))
          )}
        </div>
      </motion.div>
    </div>
  );
}
