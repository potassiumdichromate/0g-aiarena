using UnityEngine;
using AIArena.SDK.Core;

namespace AIArena.SDK.Agents
{
    /// <summary>
    /// ScriptableObject storing the behavioural parameters of an AI agent.
    /// Used by the FallbackBehaviourAI to make heuristic decisions.
    /// </summary>
    [CreateAssetMenu(fileName = "AgentBehaviourState", menuName = "AI Arena/Agent Behaviour State")]
    public class AgentBehaviourState : ScriptableObject
    {
        [Range(0f, 100f)] public float Aggression = 50f;
        [Range(0f, 100f)] public float Patience = 50f;
        [Range(0f, 100f)] public float Adaptability = 50f;
        [Range(0f, 100f)] public float RiskTolerance = 50f;
        [Range(0f, 100f)] public float Teamwork = 50f;
        [Range(0f, 100f)] public float Creativity = 50f;
        [Range(0f, 100f)] public float Endurance = 50f;
        [Range(0f, 100f)] public float Precision = 50f;

        [Header("Combat Preferences")]
        [Tooltip("Health threshold below which agent becomes more cautious")]
        [Range(0f, 1f)] public float CautiousHealthThreshold = 0.3f;

        [Tooltip("Preferred engagement distance (relative to max range)")]
        [Range(0f, 1f)] public float PreferredEngagementRange = 0.5f;

        [Header("Derived Weights (auto-calculated)")]
        public float AttackWeight;
        public float DefendWeight;
        public float FleeWeight;
        public float SupportWeight;

        /// <summary>Apply a loaded agent profile to this behaviour state.</summary>
        public void ApplyProfile(AgentProfile profile)
        {
            if (profile?.Traits == null) return;

            Aggression = profile.Traits.Aggression;
            Patience = profile.Traits.Patience;
            Adaptability = profile.Traits.Adaptability;
            RiskTolerance = profile.Traits.RiskTolerance;
            Teamwork = profile.Traits.Teamwork;
            Creativity = profile.Traits.Creativity;
            Endurance = profile.Traits.Endurance;
            Precision = profile.Traits.Precision;

            RecalculateWeights();
        }

        public void RecalculateWeights()
        {
            AttackWeight = (Aggression + RiskTolerance) / 200f;
            DefendWeight = ((100f - Aggression) + Patience) / 200f;
            FleeWeight = ((100f - RiskTolerance) + (100f - Endurance)) / 200f;
            SupportWeight = Teamwork / 100f;

            // Normalise
            float total = AttackWeight + DefendWeight + FleeWeight + SupportWeight;
            if (total > 0)
            {
                AttackWeight /= total;
                DefendWeight /= total;
                FleeWeight /= total;
                SupportWeight /= total;
            }
        }
    }
}
